#!/usr/bin/env python3
"""
autograph graph — vault graph analysis, link repair, backlinks, orphans.

Commands:
  graph.py health <vault-dir> [schema.json] [--as-of YYYY-MM-DD] — health score + report
  graph.py fix <vault-dir> [schema.json] [--apply] [--as-of YYYY-MM-DD] — fix broken links
    (repairs unique path/stem/H1-title targets; ambiguous H1 titles are listed, not touched)
  graph.py backlinks <vault-dir> <target>           — incoming links
  graph.py orphans <vault-dir>                      — files with no incoming links

All domain/type logic from schema.json. No hardcoded values.
"""

import json
import math
import os
import re
import sys
import tempfile
from pathlib import Path
from datetime import date, datetime, timedelta, timezone as datetime_timezone
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError
from collections import defaultdict

from common import (
    load_schema, parse_frontmatter, walk_vault, rel_path,
    extract_wikilinks, infer_domain, get_domain_map, IGNORE_DIRS,
    build_link_index, normalize_link_target, normalize_title,
    resolve_link_target, is_hub_path,
    read_card, write_card
)
from enforce import _outside_fences

EMBED_EXTS = {'.jpg', '.jpeg', '.png', '.gif', '.svg', '.pdf', '.mp3', '.mp4', '.webp',
              '.ogg', '.opus', '.m4a', '.wav'}


def _matches_path_hint(file_rel_path: str, pattern: str) -> bool:
    """Match a schema path hint on directory boundaries."""
    path = file_rel_path.lower().strip('/')
    hint = str(pattern).lower().strip('/')
    if not hint:
        return False
    return path == hint or path.startswith(f'{hint}/') or f'/{hint}/' in f'/{path}'


def is_managed_card(file_rel_path: str, frontmatter: dict, schema: dict) -> bool:
    """Return whether a Markdown node belongs to the schema-managed card set."""
    valid_types = set((schema.get('node_types') or {}).keys())
    if not valid_types:
        return True  # backward-compatible all-node health when no schema exists
    if frontmatter.get('type') in valid_types:
        return True
    for pattern, hinted_type in (schema.get('path_type_hints') or {}).items():
        if pattern == '_comment' or hinted_type not in valid_types:
            continue
        if _matches_path_hint(file_rel_path, pattern):
            return True
    return False


def _next_month(year: int, month: int) -> date:
    if month == 12:
        return date(year + 1, 1, 1)
    return date(year, month + 1, 1)


def _local_today() -> date:
    # Iva's Node boundary resolves ASSISTANT_TIMEZONE once and exports only a validated
    # TZ. Direct Autograph use gets the same deterministic UTC fallback.
    timezone = os.environ.get('TZ') or 'UTC'
    try:
        return datetime.now(ZoneInfo(timezone)).date()
    except (ZoneInfoNotFoundError, ValueError):
        return datetime.now(datetime_timezone.utc).date()


def expected_future_link(source: str, target: str, today: date | None = None) -> bool:
    """Classify an absent, exact Iva rollup parent that is not overdue yet.

    The scheduled creation day is included. Starting the next calendar day an
    absent parent is a real broken link.
    """
    today = today or _local_today()

    daily_match = re.fullmatch(r'summaries/daily/(\d{4})-(\d{2})-(\d{2})', source)
    if daily_match:
        try:
            child_date = date(*(int(value) for value in daily_match.groups()))
        except ValueError:
            return False
        iso_year, iso_week, _ = child_date.isocalendar()
        expected = f'weekly/{iso_year:04d}-W{iso_week:02d}'
        creation_day = date.fromisocalendar(iso_year, iso_week, 1) + timedelta(days=7)
        return target == expected and today <= creation_day

    weekly_match = re.fullmatch(r'weekly/(\d{4})-W(\d{2})', source)
    if weekly_match:
        iso_year, iso_week = (int(value) for value in weekly_match.groups())
        try:
            thursday = date.fromisocalendar(iso_year, iso_week, 4)
        except ValueError:
            return False
        expected = f'monthly/{thursday.year:04d}-{thursday.month:02d}'
        return target == expected and today <= _next_month(thursday.year, thursday.month)

    monthly_match = re.fullmatch(r'monthly/(\d{4})-(\d{2})', source)
    if monthly_match:
        year, month = (int(value) for value in monthly_match.groups())
        try:
            date(year, month, 1)
        except ValueError:
            return False
        expected = f'yearly/{year:04d}'
        return target == expected and today <= date(year + 1, 1, 1)

    return False


def _is_existing_attachment(vault_dir: Path, target: str) -> bool:
    """Return whether an attachment is a regular file contained by the vault."""
    vault_root = vault_dir.resolve()
    target_path = Path(target)
    if target_path.is_absolute() or any(part in {".", ".."} for part in target_path.parts):
        return False
    candidate = vault_root
    for part in target_path.parts:
        candidate /= part
        if candidate.is_symlink():
            return False
    try:
        candidate.resolve().relative_to(vault_root)
    except ValueError:
        return False
    return candidate.is_file()


def build_graph(vault_dir: Path, schema: dict, today: date | None = None) -> dict:
    """Scan vault, build full graph structure."""
    vault_dir = Path(vault_dir)
    files = walk_vault(vault_dir)

    link_index = build_link_index(vault_dir, files)

    nodes = {}
    all_links = []      # (source, raw_target, resolved_target)
    broken_links = []   # (source, raw_target)
    future_links = []   # (source, raw_target)
    title_links = []    # (source, raw_target), resolved by H1 only

    for md in files:
        rp = rel_path(md, vault_dir)
        rp_noext = rp.replace('.md', '')
        try:
            content = md.read_text(errors='replace')
        except Exception:
            continue

        fm, body, _ = parse_frontmatter(content)
        if fm is None:
            fm = {}

        domain = infer_domain(rp, schema)
        has_desc = bool(fm.get('description', ''))
        card_type = fm.get('type', 'unknown')
        managed = is_managed_card(rp, fm, schema)

        outgoing = []
        links = extract_wikilinks(body if body else content)
        for target, display in links:
            target_clean = normalize_link_target(target)
            resolved, strategy = resolve_link_target(target_clean, link_index)
            if resolved:
                outgoing.append(resolved)
                all_links.append((rp_noext, target_clean, resolved))
                # Такая ссылка не битая, но её цель — заголовок: H1 поменяется, и
                # ссылка порвётся. fix доводит её до пути (title_link_list).
                if strategy == 'unique_title':
                    title_links.append((rp_noext, target_clean))
            elif target_clean.startswith('attachments/') and _is_existing_attachment(
                vault_dir, target_clean
            ):
                # Attachments are valid only when the exact file exists. This is deliberately
                # extension-agnostic: DOCX and future attachment types must not become broken
                # merely because their suffix is absent from a hard-coded media allowlist.
                continue
            elif any(target.lower().endswith(ext) for ext in EMBED_EXTS):
                # A Markdown note may legitimately end in an attachment-like suffix
                # (voice.ogg.md). Resolution must win before the embed exemption.
                continue
            elif expected_future_link(rp_noext, target_clean, today=today):
                future_links.append((rp_noext, target_clean))
            else:
                broken_links.append((rp_noext, target_clean))

        nodes[rp_noext] = {
            'domain': domain,
            'type': card_type,
            'has_description': has_desc,
            'outgoing': outgoing,
            'incoming': [],  # filled below
            'link_count': len(outgoing),
            'managed': managed,
        }

    # Build incoming links
    for src, raw, resolved in all_links:
        if resolved in nodes:
            nodes[resolved]['incoming'].append(src)

    # Compute stats
    total = len(nodes)
    total_links = len(all_links)
    avg_links = total_links / max(total, 1)

    orphans = [p for p, n in nodes.items() if not n['incoming'] and not is_hub_path(p)]
    dead_ends = [p for p, n in nodes.items() if not n['outgoing'] and n['incoming']]
    desc_count = sum(1 for n in nodes.values() if n['has_description'])
    all_desc_ratio = desc_count / max(total, 1)

    managed_nodes = {path: node for path, node in nodes.items() if node['managed']}
    managed_total = len(managed_nodes)
    future_sources = {source for source, _ in future_links}
    managed_orphans = [path for path, node in managed_nodes.items()
                       if not node['incoming'] and path not in future_sources
                       and not is_hub_path(path)]
    managed_broken_links = [(source, target) for source, target in broken_links
                            if nodes.get(source, {}).get('managed')]
    managed_resolved_links = sum(node['link_count'] for node in managed_nodes.values())
    managed_future_links = sum(
        1 for source, _ in future_links if nodes.get(source, {}).get('managed')
    )
    managed_link_count = managed_resolved_links + managed_future_links
    managed_avg_links = managed_link_count / max(managed_total, 1)
    managed_desc_count = sum(1 for node in managed_nodes.values() if node['has_description'])
    desc_ratio = managed_desc_count / max(managed_total, 1)

    orphan_ratio = len(managed_orphans) / max(managed_total, 1)
    broken_ratio = len(managed_broken_links) / max(managed_total, 1)

    health = 100.0
    health -= orphan_ratio * 30
    health -= broken_ratio * 30
    health -= max(0, (3 - managed_avg_links) * 15)
    health -= (1 - desc_ratio) * 10
    health = max(0, round(health, 1))

    # Domain stats + non-standard domain detection
    valid_domains = set(get_domain_map(schema).values()) if schema else set()
    domain_stats = defaultdict(lambda: {'files': 0, 'links': 0, 'orphans': 0})
    nonstandard_domains = defaultdict(list)  # domain -> [file_paths]
    for path, node in nodes.items():
        d = node['domain']
        domain_stats[d]['files'] += 1
        domain_stats[d]['links'] += node['link_count']
        if valid_domains and d not in valid_domains:
            nonstandard_domains[d].append(path)
    for o in orphans:
        if o in nodes:
            domain_stats[nodes[o]['domain']]['orphans'] += 1

    nonstandard_count = sum(len(v) for v in nonstandard_domains.values())
    managed_nonstandard_count = sum(
        1 for node in managed_nodes.values()
        if valid_domains and node['domain'] not in valid_domains
    )
    managed_nonstandard_ratio = managed_nonstandard_count / max(managed_total, 1)
    health -= managed_nonstandard_ratio * 5  # small penalty for domain inconsistency
    health = max(0, round(health, 1))

    return {
        'generated': datetime.now().isoformat(),
        'stats': {
            'total_files': total,
            'total_links': total_links,
            'avg_links': round(avg_links, 2),
            'orphans': len(orphans),
            'dead_ends': len(dead_ends),
            'broken_links': len(broken_links),
            'desc_coverage': round(desc_ratio * 100, 1),
            'all_desc_coverage': round(all_desc_ratio * 100, 1),
            'nonstandard_domains': nonstandard_count,
            'managed_files': managed_total,
            'managed_links': managed_link_count,
            'managed_avg_links': round(managed_avg_links, 2),
            'managed_orphans': len(managed_orphans),
            'managed_broken_links': len(managed_broken_links),
            'managed_nonstandard_domains': managed_nonstandard_count,
            'future_links': len(future_links),
            'health_score': health,
        },
        'domains': dict(domain_stats),
        'nonstandard_domain_list': {k: v[:10] for k, v in nonstandard_domains.items()},
        'orphan_list': sorted(orphans),
        'dead_end_list': sorted(dead_ends),
        'broken_link_list': [{'source': s, 'target': t} for s, t in broken_links],
        'future_link_list': [{'source': s, 'target': t} for s, t in future_links],
        'title_link_list': [{'source': s, 'target': t} for s, t in title_links],
        'nodes': {k: {'domain': v['domain'], 'type': v['type'], 'has_description': v['has_description'],
                       'managed': v['managed'], 'outgoing': v['outgoing'], 'incoming': v['incoming']}
                  for k, v in nodes.items()},
    }


def resolve_link(target: str, path_index: dict) -> str | None:
    """Backward-compatible wrapper around deterministic resolver."""
    if 'exact' in path_index and 'unique_stem' in path_index:
        return resolve_link_target(target, path_index)[0]

    target = normalize_link_target(target)
    if not target:
        return None
    if target in path_index:
        return path_index[target]
    stem = target.split('/')[-1]
    if stem in path_index:
        return path_index[stem]
    return None


def generate_report(stats: dict, domains: dict) -> str:
    """Generate markdown health report."""
    s = stats
    lines = [
        f"# Vault Health Report",
        f"",
        f"Generated: {datetime.now().strftime('%Y-%m-%d %H:%M')}",
        f"",
        f"| Metric | Value |",
        f"|--------|-------|",
        f"| Health Score | **{s['health_score']}/100** |",
        f"| Total files | {s['total_files']} |",
        f"| Total links | {s['total_links']} |",
        f"| Avg links/file | {s['avg_links']} |",
        f"| Managed files | {s['managed_files']} |",
        f"| Managed avg links/file | {s['managed_avg_links']} |",
        f"| Orphans | {s['orphans']} |",
        f"| Managed orphans | {s['managed_orphans']} |",
        f"| Dead-ends | {s['dead_ends']} |",
        f"| Broken links | {s['broken_links']} |",
        f"| Managed broken links | {s['managed_broken_links']} |",
        f"| Expected future links | {s['future_links']} |",
        f"| Desc coverage | {s['desc_coverage']}% |",
        f"",
        f"## Domains",
        f"",
    ]
    for domain, ds in sorted(domains.items()):
        lines.append(f"- **{domain}**: {ds['files']} files, {ds['links']} links, {ds['orphans']} orphans")
    return '\n'.join(lines)


class HealthHistoryCorrupt(RuntimeError):
    """The health history exists but cannot be safely extended."""


class LinkRepairError(RuntimeError):
    """A link was promised as fixable and the rewrite did not happen."""


def _valid_history_entry(value) -> bool:
    if not isinstance(value, dict):
        return False
    entry_date = value.get('date')
    if (not isinstance(entry_date, str)
            or re.fullmatch(r'\d{4}-\d{2}-\d{2}', entry_date) is None):
        return False
    try:
        date.fromisoformat(entry_date)
    except ValueError:
        return False
    score = value.get('health_score')
    return (not isinstance(score, bool)
            and isinstance(score, (int, float))
            and math.isfinite(score))


def _write_history_durable(hist_path: Path, history: list) -> None:
    data = json.dumps(history, indent=2).encode('utf-8')
    fd, tmp = tempfile.mkstemp(
        dir=str(hist_path.parent), prefix='health-history.', suffix='.tmp')
    try:
        with os.fdopen(fd, 'wb') as writer:
            writer.write(data)
            writer.flush()
            os.fsync(writer.fileno())
        os.replace(tmp, hist_path)
        directory_fd = os.open(hist_path.parent, os.O_RDONLY)
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
    except BaseException:
        if os.path.exists(tmp):
            os.unlink(tmp)
        raise


def update_history(vault_dir: Path, stats: dict, as_of: date) -> None:
    """Upsert the health-history entry for as_of (max 90 entries)."""
    hist_path = vault_dir / '.graph' / 'health-history.json'
    try:
        raw = hist_path.read_bytes()
    except FileNotFoundError:
        history = []
    else:
        try:
            history = json.loads(raw.decode('utf-8'))
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise HealthHistoryCorrupt(
                'health history is corrupt; left unchanged') from error
        if (not isinstance(history, list)
                or not all(_valid_history_entry(entry) for entry in history)):
            raise HealthHistoryCorrupt(
                'health history is corrupt; left unchanged')
    # Одна запись на дату: ручной прогон того же дня заменяет результат, а не
    # добавляет второй. Старые дубли за эту дату уходят вместе с ним.
    entry = {'date': as_of.isoformat(), **stats}
    dates = [existing['date'] for existing in history]
    if entry['date'] in dates:
        first = dates.index(entry['date'])
        history = [existing for index, existing in enumerate(history)
                   if existing['date'] != entry['date'] or index == first]
        history[first] = entry
    else:
        history.append(entry)
    history = history[-90:]  # keep last 90
    _write_history_durable(hist_path, history)


# ─── FIX BROKEN LINKS ─────────────────────────────────────
# Дневной транскрипт — дословная запись дня, в расписании её не правит никто.
PROTECTED_SOURCE_PREFIX = 'summaries/'


def _protected_spans(text: str) -> list[tuple[int, int, str]]:
    """Character ranges a link repair leaves alone: code and append-only ## History."""
    lines = text.split('\n')
    outside = _outside_fences(lines)
    spans = []
    offsets = []
    offset = 0
    for line in lines:
        offsets.append(offset)
        offset += len(line) + 1
    in_history = False
    for index, line in enumerate(lines):
        start = offsets[index]
        if not outside[index]:
            spans.append((start, start + len(line), 'code'))
            continue
        if re.match(r'^## History[ \t]*$', line):
            in_history = True
        elif in_history and line.startswith('## '):
            in_history = False
        if in_history:
            spans.append((start, start + len(line), 'history'))
            continue
        for inline in re.finditer(r'`[^`\n]+`', line):
            spans.append((start + inline.start(), start + inline.end(), 'code'))
    return spans


def _protected_reason(offset: int, spans: list) -> str | None:
    """Why the link at offset must not be touched, or None when it is fair game."""
    for start, end, reason in spans:
        if start <= offset < end:
            return reason
    return None


def _link_pattern(target: str) -> re.Pattern:
    """The token forms the resolver accepts around one target: spaces, vault/, .md."""
    return re.compile(
        r'\[\[[ \t]*(?:vault/)?' + re.escape(normalize_link_target(target))
        + r'(?:\.md)?[ \t]*(?P<anchor>#[^\]|]+)?(?P<alias>\|[^\]]+)?\]\]'
    )


def fix_broken_links(vault_dir: Path, graph: dict, apply: bool = False) -> tuple[list, int, list, list]:
    """Suggest and optionally apply fixes for broken links.

    Returns (fixes, applied, ambiguous, skipped). Ambiguous H1 titles are reported with
    their candidates and left untouched — guessing one of them would rewrite a Card
    wrongly. Daily transcripts, the append-only ## History section and code are not
    repair candidates at all: they are skipped and named, never promised as Fixable.
    """
    link_index = build_link_index(vault_dir)

    # Единственный список стратегий, которые fix имеет право применить: ровно один
    # кандидат. ambiguous_* сюда не попадают никогда.
    allowed = ('unique_suffix', 'unique_stem', 'unique_title')

    fixes = []
    ambiguous = []
    skipped = []

    # Карточка читается один раз: и спаны защиты, и замена смотрят на те же байты.
    cards: dict[str, tuple[str, list] | None] = {}

    def card_of(source: str):
        if source not in cards:
            path = vault_dir / f'{source}.md'
            content = read_card(path) if path.exists() else None
            cards[source] = (
                None if content is None else (content, _protected_spans(content)))
        return cards[source]

    def candidate(source: str, target: str, resolved: str, strategy: str) -> None:
        """Кладёт ссылку в fixes или в skipped — третьего исхода нет."""
        if source.startswith(PROTECTED_SOURCE_PREFIX):
            skipped.append({'source': source, 'target': target, 'reason': 'summaries'})
            return
        card = card_of(source)
        if card is None:
            skipped.append({'source': source, 'target': target, 'reason': 'unreadable'})
            return
        text, spans = card
        reasons = [_protected_reason(match.start(), spans)
                   for match in _link_pattern(target).finditer(text)]
        # Ссылка целиком под защитой — не кандидат. Если хотя бы одно её вхождение
        # в свободном тексте, чинится именно оно, а защищённые остаются как были.
        if reasons and all(reason is not None for reason in reasons):
            skipped.append({'source': source, 'target': target, 'reason': reasons[0]})
            return
        fixes.append({
            'source': source,
            'old': target,
            'new': resolved,
            'strategy': strategy
        })

    for bl in graph['broken_link_list']:
        src = bl['source']
        target = bl['target']
        resolved, strategy = resolve_link_target(target, link_index)
        if resolved and strategy in allowed:
            candidate(src, target, resolved, strategy)
        elif strategy == 'ambiguous_title':
            ambiguous.append({
                'source': src,
                'target': target,
                'candidates': link_index['ambiguous_title'][
                    normalize_title(normalize_link_target(target))]
            })

    # Ссылка по заголовку резолвится, поэтому в битых её нет. Путь вместо заголовка
    # переживёт правку H1, и fix — тот проход, который доводит её до канонической формы.
    for tl in graph.get('title_link_list', []):
        resolved, strategy = resolve_link_target(tl['target'], link_index)
        if resolved and strategy in allowed:
            candidate(tl['source'], tl['target'], resolved, strategy)

    if apply:
        applied = 0
        rewritten: set[tuple[str, str]] = set()
        for fix in fixes:
            src_path = vault_dir / (fix['source'] + '.md')
            if not src_path.exists():
                continue
            # Читаем строго и пишем атомарно: всё прочитанное здесь уходит обратно в тот
            # же файл, а errors='replace' затёр бы недекодируемые байты навсегда.
            content = read_card(src_path)
            if content is None:
                continue
            # Замена ищет те же формы токена, что принимает резолвер, и считает именно
            # переписанные ссылки: две ссылки на одну цель различаются anchor/alias
            # и обе попадают под общий токен цели. Защищённые вхождения не трогаем.
            spans = _protected_spans(content)
            count = 0

            def replace(match, _fix=fix, _spans=spans):
                nonlocal count
                if _protected_reason(match.start(), _spans) is not None:
                    return match.group(0)
                count += 1
                return (f"[[{_fix['new']}{match.group('anchor') or ''}"
                        f"{match.group('alias') or ''}]]")

            content = _link_pattern(fix['old']).sub(replace, content)
            if count:
                write_card(src_path, content)
                applied += count
                rewritten.add((fix['source'], fix['old']))
        # Fixable обещает починку: обещанная и не переписанная ссылка — отказ, а не тишина.
        missed = sorted({(fix['source'], fix['old']) for fix in fixes} - rewritten)
        if missed:
            raise LinkRepairError(
                'link repair promised a fix and rewrote nothing: '
                + ', '.join(f'{source}: [[{target}]]' for source, target in missed))
        return fixes, applied, ambiguous, skipped
    return fixes, 0, ambiguous, skipped


# ─── BACKLINKS ─────────────────────────────────────────────
def find_text_mentions(vault_dir: Path, target: str, wikilink_sources: set) -> list:
    """Find plain-text mentions of target stem (not wikilinks) in vault files."""
    stem = target.replace('.md', '').split('/')[-1]
    # Build search variants: stem as-is and with spaces instead of hyphens
    variants = {stem.lower()}
    if '-' in stem:
        variants.add(stem.replace('-', ' ').lower())
        # Also add concatenated form: "foobar" from "foo-bar"
        variants.add(stem.replace('-', '').lower())

    mentions = []
    wikilink_pat = re.compile(r'\[\[[^\]]*\]\]')

    for md in walk_vault(vault_dir):
        rp = rel_path(md, vault_dir).replace('.md', '')
        if rp in wikilink_sources or rp == target.replace('.md', ''):
            continue  # skip files already found via wikilinks
        try:
            content = md.read_text(errors='replace').lower()
        except Exception:
            continue
        # Strip wikilinks so we only find plain-text mentions
        content_no_wl = wikilink_pat.sub('', content)
        for v in variants:
            if v in content_no_wl:
                mentions.append(rp)
                break

    return sorted(set(mentions))


def find_backlinks(graph: dict, target: str, vault_dir: Path = None) -> tuple[list, list]:
    """Find all files linking to target.
    Returns: (wikilink_backlinks, text_mentions) if vault_dir given,
             else (wikilink_backlinks, []) for backward compat."""
    # Normalize target
    target_clean = target.replace('.md', '')
    results = []

    if target_clean in graph['nodes']:
        for src in graph['nodes'][target_clean].get('incoming', []):
            results.append(src)
    else:
        # Fuzzy: check if target is a stem
        stem = target_clean.split('/')[-1]
        for path, node in graph['nodes'].items():
            if path.endswith(stem):
                for src in node.get('incoming', []):
                    results.append(src)

    wikilinks = sorted(set(results))

    # Text mentions (optional, needs vault_dir)
    text_mentions = []
    if vault_dir:
        text_mentions = find_text_mentions(vault_dir, target_clean, set(wikilinks))

    return wikilinks, text_mentions


# ─── CLI ───────────────────────────────────────────────────
def find_schema(args: list, vault_dir: Path) -> Path | None:
    """Find schema.json in args or default location."""
    for a in args:
        if a.endswith('.json') and Path(a).exists():
            return Path(a)
    vault_schema = vault_dir / 'schema.json'
    if vault_schema.exists():
        return vault_schema
    default = Path(__file__).parent.parent / 'schema.json'
    if default.exists():
        return default
    return None


def find_as_of(args: list) -> date | None:
    if '--as-of' not in args:
        return None
    index = args.index('--as-of')
    if index + 1 >= len(args):
        raise ValueError('--as-of requires YYYY-MM-DD')
    try:
        return date.fromisoformat(args[index + 1])
    except ValueError as error:
        raise ValueError('--as-of requires a valid YYYY-MM-DD') from error


def main():
    args = sys.argv[1:]
    if not args or args[0] in ('-h', '--help'):
        print(__doc__)
        sys.exit(0)

    cmd = args[0]
    vault_dir = Path(args[1]) if len(args) > 1 else None

    if not vault_dir or not vault_dir.is_dir():
        print(f"Error: vault directory required", file=sys.stderr)
        sys.exit(1)

    schema_path = find_schema(args, vault_dir)
    schema = load_schema(schema_path) if schema_path else {}
    try:
        as_of = find_as_of(args)
    except ValueError as error:
        print(f"Error: {error}", file=sys.stderr)
        sys.exit(1)
    # Дата графа и дата записи истории — одна и та же: без --as-of это сегодня по
    # TZ процесса, а не момент записи.
    if as_of is None:
        as_of = _local_today()

    if cmd == 'health':
        graph = build_graph(vault_dir, schema, today=as_of)
        stats = graph['stats']

        # Save outputs
        out_dir = vault_dir / '.graph'
        out_dir.mkdir(exist_ok=True)
        (out_dir / 'vault-graph.json').write_text(
            json.dumps(graph, indent=2, ensure_ascii=False, default=str))
        (out_dir / 'report.md').write_text(
            generate_report(stats, graph['domains']))
        try:
            update_history(vault_dir, stats, as_of)
        except HealthHistoryCorrupt as error:
            print(f"Error: {error}", file=sys.stderr)
            sys.exit(1)

        print(f"\n{'='*50}")
        print(f"Health Score:     {stats['health_score']}/100")
        print(f"Total files:      {stats['total_files']}")
        print(f"Total links:      {stats['total_links']}")
        print(f"Avg links/file:   {stats['avg_links']}")
        print(f"Managed files:    {stats['managed_files']}")
        print(f"Managed avg links:{stats['managed_avg_links']:>7}")
        print(f"Orphan files:     {stats['orphans']}")
        print(f"Managed orphans:  {stats['managed_orphans']}")
        print(f"Dead-ends:        {stats['dead_ends']}")
        print(f"Broken links:     {stats['broken_links']}")
        print(f"Managed broken:   {stats['managed_broken_links']}")
        print(f"Future links:     {stats['future_links']}")
        print(f"Desc coverage:    {stats['desc_coverage']}%")
        ns_count = stats.get('nonstandard_domains', 0)
        if ns_count > 0:
            print(f"Bad domains:      {ns_count}")
        print(f"{'='*50}")
        for d, ds in sorted(graph['domains'].items()):
            print(f"  {d}: {ds['files']} files, {ds['links']} links, {ds['orphans']} orphans")
        ns_list = graph.get('nonstandard_domain_list', {})
        if ns_list:
            print(f"\n  Non-standard domains ({ns_count} files):")
            for domain, files in sorted(ns_list.items()):
                print(f"    '{domain}' ({len(files)} files): {', '.join(files[:5])}")

    elif cmd == 'fix':
        graph = build_graph(vault_dir, schema, today=as_of)
        apply = '--apply' in args
        try:
            fixes, applied, ambiguous, skipped = fix_broken_links(
                vault_dir, graph, apply=apply)
        except LinkRepairError as error:
            print(f"Error: {error}", file=sys.stderr)
            sys.exit(1)
        mode = 'APPLIED' if apply else 'DRY RUN'
        print(f"\n  Broken links: {len(graph['broken_link_list'])}")
        print(f"  Fixable:      {len(fixes)}")
        if apply:
            print(f"  Applied:      {applied}")
        print(f"  Ambiguous:    {len(ambiguous)}  (left as is)")
        for a in ambiguous[:20]:
            print(f"    {a['source']}: [[{a['target']}]] -> {', '.join(a['candidates'])}")
        print(f"  Skipped (protected): {len(skipped)}")
        for s in skipped[:20]:
            print(f"    {s['source']}: [[{s['target']}]] ({s['reason']})")
        for f in fixes[:20]:
            print(f"    {f['source']}: {f['old']} → {f['new']}")

    elif cmd == 'backlinks':
        target = args[2] if len(args) > 2 else None
        if not target:
            print("Usage: graph.py backlinks <vault> <target>", file=sys.stderr)
            sys.exit(1)
        graph = build_graph(vault_dir, schema, today=as_of)
        wikilinks, mentions = find_backlinks(graph, target, vault_dir)
        print(f"Backlinks to '{target}': {len(wikilinks)} wikilinks, {len(mentions)} text mentions")
        if wikilinks:
            print(f"\n  Wikilinks ({len(wikilinks)}):")
            for b in wikilinks:
                print(f"    ← {b}")
        if mentions:
            print(f"\n  Text mentions ({len(mentions)}):")
            for m in mentions:
                print(f"    ~ {m}")

    elif cmd == 'orphans':
        graph = build_graph(vault_dir, schema, today=as_of)
        orphans = graph['orphan_list']
        print(f"Orphans: {len(orphans)}")
        for o in orphans:
            print(f"  {o}")

    else:
        print(f"Unknown command: {cmd}", file=sys.stderr)
        sys.exit(1)


if __name__ == '__main__':
    main()
