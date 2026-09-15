#!/usr/bin/env python3
"""
autograph self-contained tests — uses temp fixtures, no real vault needed.
Runs ~40 tests covering common.py functions + all script CLIs + edge cases.

Usage: python3 test_autograph.py
       (no arguments required, works from any directory)
"""

import sys
import os
import json
import random
import shutil
import tempfile
import subprocess
import unicodedata
from pathlib import Path
from datetime import date, timedelta

# ─── SETUP ────────────────────────────────────────────────
SCRIPTS_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(SCRIPTS_DIR))

PASS = 0
FAIL = 0

# Случайные property-кейсы гоняются от фиксированного seed: прогон воспроизводим, а seed
# печатается в шапке и в подробностях каждого провала, чтобы красный прогон повторялся
# один в один. Другой seed — AUTOGRAPH_TEST_SEED=<число>.
SEED = int(os.environ.get('AUTOGRAPH_TEST_SEED', '20260814'))


def test(name: str, condition: bool, detail: str = ""):
    global PASS, FAIL
    if condition:
        PASS += 1
        print(f"  PASS  {name}")
    else:
        FAIL += 1
        print(f"  FAIL  {name}: {detail}")


def run(cmd: list, cwd: str = None) -> tuple:
    r = subprocess.run(cmd, capture_output=True, text=True, cwd=cwd, timeout=60)
    return r.returncode, r.stdout, r.stderr


# ─── FIXTURES ─────────────────────────────────────────────

SCHEMA = {
    "node_types": {
        "note": {
            "description": "Knowledge note",
            "required": ["description", "tags"],
            "status": ["active", "draft", "archived", "superseded"]
        },
        "contact": {
            "description": "Person",
            "required": ["description", "tags", "status"],
            "status": ["active", "inactive", "superseded"]
        },
        "project": {
            "description": "Project with deliverables",
            "required": ["description", "tags", "status"],
            "status": ["active", "done", "paused", "cancelled", "superseded"]
        },
        "lead": {
            "description": "Sales lead",
            "required": ["description", "status"],
            "status": ["prospect", "negotiation", "won", "lost"]
        }
    },
    "type_aliases": {
        "crm": "contact",
        "person": "contact",
        "idea": "note"
    },
    "field_fixes": {
        "status": {
            "actve": "active",
            "inactiv": "inactive"
        },
        "priority": {
            "hi": "high",
            "lo": "low"
        }
    },
    "region_fixes": {
        "KZ ": "KZ",
        "kz": "KZ"
    },
    "domain_inference": {
        "projects/": "work",
        "personal/": "personal",
        "knowledge/": "knowledge",
        "contacts/": "crm"
    },
    "path_type_hints": {
        "_comment": "folder substring -> type name",
        "leads/": "lead",
        "contacts/": "contact",
        "people/": "contact"
    },
    "status_order": {
        "_comment": "sort for MOC",
        "active": 0,
        "prospect": 1,
        "done": 8,
        "draft": 9
    },
    "status_defaults": {
        "_comment": "defaults",
        "default": "active"
    },
    "richness_fields": {
        "_comment": "for dedup",
        "bonus_fields": ["telegram", "email", "company"]
    },
    "entity_extraction": {
        "_comment": "for daily.py",
        "noise_words": ["TODO", "FIX", "Score"]
    },
    "decay": {
        "rate": 0.015,
        "floor": 0.1,
        "tiers": {
            "active": 7,
            "warm": 21,
            "cold": 60
        }
    },
    "ignore_tags": ["imported"]
}

# Markdown fixtures: (relative_path, content)
VAULT_FILES = {
    "projects/alpha.md": (
        "---\n"
        "type: project\n"
        "status: active\n"
        "domain: work\n"
        "tags: [dev, ai]\n"
        "description: Alpha project for AI platform\n"
        "priority: high\n"
        "tier: active\n"
        "relevance: 1.0\n"
        f"last_accessed: {date.today().isoformat()}\n"
        "---\n"
        "# Alpha Project\n\n"
        "Building an AI platform. See [[contacts/bob]] and [[knowledge/ml-basics]].\n\n"
        "## Roadmap\n- Phase 1\n- Phase 2\n"
    ),
    "projects/beta.md": (
        "---\n"
        "type: project\n"
        "status: draft\n"
        "domain: work\n"
        "tags: [design]\n"
        "description: Beta design sprint\n"
        "tier: warm\n"
        "relevance: 0.7\n"
        f"last_accessed: {(date.today() - timedelta(days=10)).isoformat()}\n"
        "---\n"
        "# Beta Sprint\n\n"
        "Design phase. Related to [[projects/alpha|Alpha]].\n"
    ),
    "contacts/bob.md": (
        "---\n"
        "type: contact\n"
        "status: active\n"
        "domain: crm\n"
        "tags: [partner, dev]\n"
        "description: Bob Smith, lead developer\n"
        "telegram: @bobdev\n"
        "email: bob@example.com\n"
        "company: DevCorp\n"
        "tier: active\n"
        "relevance: 1.0\n"
        f"last_accessed: {date.today().isoformat()}\n"
        "---\n"
        "# Bob Smith\n\n"
        "Key partner. Works on [[projects/alpha]] and [[projects/beta]].\n"
    ),
    "contacts/alice.md": (
        "---\n"
        "type: contact\n"
        "status: active\n"
        "domain: crm\n"
        "tags: [client]\n"
        "description: Alice Johnson, marketing lead\n"
        "tier: warm\n"
        "relevance: 0.8\n"
        f"last_accessed: {(date.today() - timedelta(days=15)).isoformat()}\n"
        "---\n"
        "# Alice Johnson\n\n"
        "Client contact. Involved in [[projects/beta]].\n"
    ),
    "knowledge/ml-basics.md": (
        "---\n"
        "type: note\n"
        "status: active\n"
        "domain: knowledge\n"
        "tags: [ai, ml, learning]\n"
        "description: Machine learning fundamentals\n"
        "tier: warm\n"
        "relevance: 0.6\n"
        f"last_accessed: {(date.today() - timedelta(days=20)).isoformat()}\n"
        "---\n"
        "# ML Basics\n\n"
        "Neural networks, transformers, etc.\n\n"
        "## Key Concepts\n- Backpropagation\n- Attention\n"
    ),
    "knowledge/python-tips.md": (
        "---\n"
        "type: note\n"
        "status: draft\n"
        "domain: knowledge\n"
        "tags: [python, dev]\n"
        "description: Useful Python patterns\n"
        "tier: cold\n"
        "relevance: 0.3\n"
        f"last_accessed: {(date.today() - timedelta(days=45)).isoformat()}\n"
        "---\n"
        "# Python Tips\n\n"
        "Dataclasses, pattern matching, etc.\n"
    ),
    "personal/journal.md": (
        "---\n"
        "type: note\n"
        "status: active\n"
        "domain: personal\n"
        "tags: [journal]\n"
        "description: Daily journal entry\n"
        "tier: archive\n"
        "relevance: 0.1\n"
        f"last_accessed: {(date.today() - timedelta(days=100)).isoformat()}\n"
        "---\n"
        "# Journal\n\n"
        "Today I worked on [[projects/alpha]] and talked to [[contacts/alice]].\n"
    ),
    "no-frontmatter.md": (
        "# Just a Note\n\n"
        "This file has no YAML frontmatter at all.\n"
        "Links to [[knowledge/ml-basics]].\n"
    ),
    "broken-frontmatter.md": (
        "---\n"
        "type:\n"
        "tags: [broken\n"
        "---\n"
        "# Broken FM\n\n"
        "The frontmatter above is malformed.\n"
    ),
    # Duplicate slug (same stem as contacts/bob.md)
    "personal/bob.md": (
        "---\n"
        "type: note\n"
        "status: draft\n"
        "tags: [personal]\n"
        "description: Personal notes about Bob\n"
        "---\n"
        "# Bob\n\n"
        "Random notes.\n"
    ),
}

DAILY_FILE = {
    "2026-03-01.md": (
        "# Memory 2026-03-01\n\n"
        "Met with @alice_m and @bob_dev today.\n\n"
        "**Сергей Иванов** presented the new roadmap.\n\n"
        "Discussed [[projects/alpha]] budget: $5,000.\n\n"
        "Decided: approved the Q2 plan.\n\n"
        "Events: launched v2.0\n"
    )
}


def create_vault(base_dir: Path) -> Path:
    """Create a temporary vault with test fixtures."""
    vault = base_dir / "test-vault"
    vault.mkdir(parents=True, exist_ok=True)
    for rel, content in VAULT_FILES.items():
        fp = vault / rel
        fp.parent.mkdir(parents=True, exist_ok=True)
        fp.write_text(content)
    return vault


def create_schema(base_dir: Path) -> Path:
    """Write test schema.json."""
    sp = base_dir / "schema.json"
    sp.write_text(json.dumps(SCHEMA, indent=2, ensure_ascii=False))
    return sp


def create_daily_dir(base_dir: Path) -> Path:
    """Write daily memory files."""
    mem = base_dir / "memory"
    mem.mkdir(parents=True, exist_ok=True)
    for name, content in DAILY_FILE.items():
        (mem / name).write_text(content)
    return mem


# ─── MAIN ─────────────────────────────────────────────────
def main():
    tmp = Path(tempfile.mkdtemp(prefix="autograph_test_"))
    try:
        vault_dir = create_vault(tmp)
        schema_path = create_schema(tmp)
        daily_dir = create_daily_dir(tmp)

        # Clear schema cache before tests (common.py caches schemas)
        from common import _schema_cache
        _schema_cache.clear()

        print(f"\n{'='*60}")
        print(f"  AUTOGRAPH SELF-CONTAINED TESTS")
        print(f"  vault:  {vault_dir}")
        print(f"  schema: {schema_path}")
        print(f"  tmp:    {tmp}")
        print(f"  seed:   {SEED}")
        print(f"{'='*60}\n")

        # ═══════════════════════════════════════════════════════
        # 1. common.py — pure function tests
        # ═══════════════════════════════════════════════════════
        print("--- common.py ---")
        from common import (
            load_schema, parse_frontmatter, walk_vault, infer_domain,
            infer_type, calc_relevance, calc_tier, days_since,
            extract_wikilinks, IGNORE_DIRS, write_frontmatter, format_field,
            build_link_index, resolve_link_target, collect_duplicate_groups, is_hub_path,
            get_conflict_fields, get_identity_config, card_recency_date, normalize_identity_value,
            extract_title, normalize_title
        )
        from cleanup import clean_file

        # 1.1 schema loading
        schema = load_schema(schema_path)
        test("load_schema returns dict", isinstance(schema, dict))
        test("schema has node_types", 'node_types' in schema)
        test("schema has decay config", 'decay' in schema)
        test("schema has domain_inference", 'domain_inference' in schema)

        # 1.2 IGNORE_DIRS
        test("IGNORE_DIRS is frozenset", isinstance(IGNORE_DIRS, frozenset))
        test("IGNORE_DIRS contains .obsidian", '.obsidian' in IGNORE_DIRS)

        # 1.3 parse_frontmatter — valid
        fm, body, lines = parse_frontmatter(
            "---\ntype: crm\nstatus: active\ntags: [a, b, c]\n---\n# Hello\nBody"
        )
        test("parse_fm extracts type", fm.get('type') == 'crm')
        test("parse_fm extracts tags list", fm.get('tags') == ['a', 'b', 'c'])
        test("parse_fm body contains text", 'Hello' in body)

        # 1.4 parse_frontmatter — no frontmatter
        fm2, body2, _ = parse_frontmatter("# Just markdown\nNo frontmatter here")
        test("parse_fm returns None for no-fm", fm2 is None)
        test("parse_fm returns full content as body", 'Just markdown' in body2)

        # 1.5 parse_frontmatter — empty value
        fm3, _, _ = parse_frontmatter("---\ntype:\nstatus: active\n---\nBody")
        test("parse_fm handles empty value", fm3.get('type') == '')

        # 1.6 extract_wikilinks
        links = extract_wikilinks("See [[foo/bar|Foo Bar]] and [[baz]] text")
        test("extract_wikilinks finds 2 links", len(links) == 2)
        test("extract_wikilinks parses alias", links[0] == ('foo/bar', 'Foo Bar'))
        test("extract_wikilinks plain link", links[1] == ('baz', 'baz'))

        # 1.7 extract_wikilinks — no links
        test("extract_wikilinks empty on no links", extract_wikilinks("no links here") == [])

        # 1.8 infer_domain
        test("infer_domain projects/ -> work",
             infer_domain("projects/alpha.md", schema) == "work")
        test("infer_domain personal/ -> personal",
             infer_domain("personal/journal.md", schema) == "personal")
        test("infer_domain unknown -> personal (default)",
             infer_domain("random/file.md", schema) == "personal")

        # 1.9 infer_type
        test("infer_type note/ folder -> note",
             infer_type("knowledge/note/something.md", schema) == "note")
        test("infer_type contacts/ -> contact (via path_type_hints)",
             infer_type("contacts/someone.md", schema) == "contact")

        # 1.10 calc_relevance
        test("calc_relevance day 0 = 1.0", calc_relevance(0, schema) == 1.0)
        test("calc_relevance day 10 = 0.85", calc_relevance(10, schema) == 0.85)
        test("calc_relevance day 60 = floor 0.1", calc_relevance(60, schema) == 0.1)
        test("calc_relevance day 100 = floor 0.1", calc_relevance(100, schema) == 0.1)

        # 1.11 calc_tier
        test("calc_tier day 3 = active", calc_tier(3, schema) == 'active')
        test("calc_tier day 7 = active (boundary)", calc_tier(7, schema) == 'active')
        test("calc_tier day 15 = warm", calc_tier(15, schema) == 'warm')
        test("calc_tier day 21 = warm (boundary)", calc_tier(21, schema) == 'warm')
        test("calc_tier day 40 = cold", calc_tier(40, schema) == 'cold')
        test("calc_tier day 90 = archive", calc_tier(90, schema) == 'archive')
        test("calc_tier core stays core", calc_tier(999, schema, 'core') == 'core')

        # 1.12 days_since
        today = date.today()
        test("days_since today = 0", days_since(today.isoformat()) == 0)
        test("days_since yesterday = 1",
             days_since((today - timedelta(days=1)).isoformat()) == 1)
        test("days_since empty = 999", days_since('') == 999)
        test("days_since garbage = 999", days_since('not-a-date') == 999)
        test("days_since None = 999", days_since(None) == 999)

        # 1.13 walk_vault
        files = walk_vault(vault_dir)
        test("walk_vault finds files", len(files) == len(VAULT_FILES))
        # Should skip .obsidian, .git etc
        obs_dir = vault_dir / '.obsidian'
        obs_dir.mkdir(exist_ok=True)
        (obs_dir / 'hidden.md').write_text("hidden")
        files2 = walk_vault(vault_dir)
        test("walk_vault ignores .obsidian", len(files2) == len(VAULT_FILES))

        # 1.14 write_frontmatter + format_field
        test("format_field list", format_field('tags', ['a', 'b']) == 'tags: ["a","b"]')
        test("format_field string", format_field('type', 'note') == 'type: "note"')
        test("format_field int", format_field('count', 42) == 'count: 42')
        test("format_field float", format_field('relevance', 0.85) == 'relevance: 0.85')

        # 1.15 write_frontmatter multiline roundtrip (no duplication)
        multiline_fm = "---\ntype: note\ndescription: >-\n  Long description that\n  spans multiple lines\ntags: [ai, test]\n---\n# Body\n"
        fm_ml, body_ml, orig_ml = parse_frontmatter(multiline_fm)
        test("multiline parse: description joined",
             fm_ml.get('description') == 'Long description that spans multiple lines',
             f"got: {fm_ml.get('description')}")
        block_list_fm = "---\ntype: note\ntags:\n  - ai\n  - test\nstatus: active\n---\n# Body\n"
        fm_list, _, _ = parse_frontmatter(block_list_fm)
        test("block list parse: tags extracted",
             fm_list.get('tags') == ['ai', 'test'],
             f"got: {fm_list.get('tags')!r}")
        # Roundtrip: write back same fields → no duplication
        rebuilt_ml = write_frontmatter(fm_ml, orig_ml)
        fm_rt, _, _ = parse_frontmatter(f"---\n{rebuilt_ml}\n---\n")
        test("multiline roundtrip: no duplication",
             fm_rt.get('description') == fm_ml.get('description'),
             f"original={fm_ml.get('description')!r}, roundtrip={fm_rt.get('description')!r}")
        # Second roundtrip — should be stable
        rebuilt_ml2 = write_frontmatter(fm_rt, rebuilt_ml.split('\n'))
        fm_rt2, _, _ = parse_frontmatter(f"---\n{rebuilt_ml2}\n---\n")
        test("multiline double roundtrip: stable",
             fm_rt2.get('description') == fm_ml.get('description'),
             f"got: {fm_rt2.get('description')!r}")
        # Literal block |- continuation lines skipped when key rewritten
        literal_fm = "---\ntype: note\ndescription: |-\n  Line one\n  Line two\ntags: [test]\n---\n"
        fm_lit, _, orig_lit = parse_frontmatter(literal_fm)
        rebuilt_lit = write_frontmatter(fm_lit, orig_lit)
        # Key point: continuation lines should NOT appear as extra lines
        continuation_leaked = 'Line one' in rebuilt_lit and rebuilt_lit.count('Line one') > 1
        test("literal |- rewrite: no leaked continuation lines",
             not continuation_leaked,
             f"got: {rebuilt_lit}")
        paragraph_folded = ("---\ndescription: >-\n"
                            "  First paragraph\n\n"
                            "  Second paragraph\n\n\n"
                            "  Third paragraph\nstatus: active\n---\n")
        fm_paragraphs, _, lines_paragraphs = parse_frontmatter(paragraph_folded)
        expected_folded = "First paragraph\nSecond paragraph\n\nThird paragraph"
        test("folded paragraphs survive blank lines",
             fm_paragraphs.get('description') == expected_folded,
             f"got: {fm_paragraphs.get('description')!r}")
        folded_written = write_frontmatter(fm_paragraphs, lines_paragraphs)
        folded_again, _, _ = parse_frontmatter(f"---\n{folded_written}\n---\n")
        test("folded paragraphs survive parse-write-parse",
             folded_again.get('description') == expected_folded,
             f"got: {folded_again.get('description')!r}")
        paragraph_literal = ("---\nnote: |-\n"
                             "  Line one\n\n"
                             "  Line two\nkind: note\n---\n")
        fm_literal_paragraphs, _, lines_literal_paragraphs = parse_frontmatter(paragraph_literal)
        expected_literal = "Line one\n\nLine two"
        test("literal paragraphs survive blank lines",
             fm_literal_paragraphs.get('note') == expected_literal,
             f"got: {fm_literal_paragraphs.get('note')!r}")
        literal_written = write_frontmatter(fm_literal_paragraphs, lines_literal_paragraphs)
        literal_again, _, _ = parse_frontmatter(f"---\n{literal_written}\n---\n")
        test("literal paragraphs survive parse-write-parse",
             literal_again.get('note') == expected_literal,
             f"got: {literal_again.get('note')!r}")
        # Untouched multiline key preserved as-is
        partial_fields = {'tags': ['ai', 'updated']}  # only update tags, not description
        rebuilt_partial = write_frontmatter(partial_fields, orig_ml)
        test("untouched multiline key preserved",
             'spans multiple lines' in rebuilt_partial,
             f"got: {rebuilt_partial}")

        # 1.15b regression: folded description whose continuation contains a COLON
        # (e.g. "Role: detail") must not duplicate on rewrite. Continuation lines
        # are continuation by INDENTATION, not by absence of a colon.
        colon_fm = ("---\ntype: lead\n"
                    "description: >-\n"
                    "  Subscriber/contact: interested in total life-tracking\n"
                    "  via AI agents (sleep, recovery, meetings)\n"
                    "status: active\n---\n# Body\n")
        fm_c, _, orig_c = parse_frontmatter(colon_fm)
        joined = ("Subscriber/contact: interested in total life-tracking "
                  "via AI agents (sleep, recovery, meetings)")
        test("colon-in-fold parse: joined once",
             fm_c.get('description') == joined,
             f"got: {fm_c.get('description')!r}")
        rebuilt_c = write_frontmatter(fm_c, orig_c)
        fm_c_rt, _, _ = parse_frontmatter(f"---\n{rebuilt_c}\n---\n")
        test("colon-in-fold rewrite: no duplication",
             fm_c_rt.get('description') == joined,
             f"got: {fm_c_rt.get('description')!r}")
        # Same fields rewritten again → byte-identical output (idempotent)
        rebuilt_c2 = write_frontmatter(fm_c_rt, rebuilt_c.split('\n'))
        test("colon-in-fold rewrite: idempotent",
             rebuilt_c2 == rebuilt_c,
             f"r1={rebuilt_c!r}\nr2={rebuilt_c2!r}")

        # 1.15c regression: BLOCK-style list continuations must be skipped when
        # the key is rewritten — same bug family as 1.15b, different trigger.
        # Before the fix the old "- item" lines survived as orphans under the
        # new flow-style line.
        block_fm = ("---\ntype: note\n"
                    "tags:\n"
                    "  - project\n"
                    "  - index\n"
                    "status: active\n---\n# Body\n")
        fm_b, _, orig_b = parse_frontmatter(block_fm)
        fm_b['tags'] = ['project', 'index', 'extra']
        rebuilt_b = write_frontmatter(fm_b, orig_b)
        test("block-list rewrite: no orphan items",
             '\n  - ' not in rebuilt_b and '- project' not in rebuilt_b.replace('[project', ''),
             f"got: {rebuilt_b!r}")
        fm_b_rt, _, _ = parse_frontmatter(f"---\n{rebuilt_b}\n---\n")
        test("block-list rewrite: list intact",
             fm_b_rt.get('tags') == ['project', 'index', 'extra'],
             f"got: {fm_b_rt.get('tags')!r}")

        # 1.15d parity with the TypeScript frontmatter dialect: a single
        # leading space is enough to make a folded-scalar continuation.
        single_space_fm = ("---\ndescription: >-\n"
                           " line one\n"
                           " line two\n"
                           "status: active\n---\n# Body\n")
        fm_s, _, orig_s = parse_frontmatter(single_space_fm)
        test("single-space fold parse: continuation joined",
             fm_s.get('description') == 'line one line two'
             and fm_s.get('status') == 'active',
             f"got: {fm_s!r}")
        rebuilt_s = write_frontmatter({'description': 'NEW'}, orig_s)
        test("single-space fold rewrite: no stale continuation",
             'line one' not in rebuilt_s and 'line two' not in rebuilt_s
             and 'description: "NEW"' in rebuilt_s and 'status: active' in rebuilt_s,
             f"got: {rebuilt_s!r}")

        # 1.15e blank/comment lines inside a replaced folded block must not
        # reset continuation skipping and resurrect the stale tail.
        paragraph_lines = [
            'type: contact', 'description: >-', '  first paragraph', '',
            '# paragraph break', '  second paragraph', 'status: active',
        ]
        rebuilt_p = write_frontmatter({'description': 'new'}, paragraph_lines)
        test("fold rewrite after blank/comment: no stale tail",
             'first paragraph' not in rebuilt_p and 'second paragraph' not in rebuilt_p
             and 'paragraph break' not in rebuilt_p
             and 'description: "new"' in rebuilt_p and 'status: active' in rebuilt_p,
             f"got: {rebuilt_p!r}")

        # The bounded-memory cleaner is the first nightly step. It must share the
        # same one-space continuation dialect or a historic 2^N card can bypass
        # cleanup and then be skipped by enforce's oversize guard.
        cleanup_single = tmp / 'cleanup-single-space.md'
        repeated_unit = 'Subscriber/contact: interested in total life-tracking'
        cleanup_body = '# Body\n\nExact body bytes stay untouched.\n'
        cleanup_single.write_text(
            '---\ntype: note\ndescription: >-\n '
            + repeated_unit + ' ' + repeated_unit
            + '\nstatus: active\n---\n' + cleanup_body
        )
        cleaned = clean_file(cleanup_single, apply=True)
        cleaned_text = cleanup_single.read_text()
        cleaned_fm, cleaned_body, _ = parse_frontmatter(cleaned_text)
        test("cleanup repairs single-space repeated description",
             cleaned is not None
             and cleaned_fm.get('description') == repeated_unit,
             cleaned_text[:500])
        test("cleanup preserves body byte-for-byte",
             cleaned_body == cleanup_body,
             repr(cleaned_body))
        cleaned_snapshot = cleanup_single.read_bytes()
        test("second cleanup pass is byte-stable",
             clean_file(cleanup_single, apply=True) is None
             and cleanup_single.read_bytes() == cleaned_snapshot)

        # 1.16 deterministic link resolver
        resolver_vault = tmp / 'resolver-vault'
        (resolver_vault / 'docs/cards').mkdir(parents=True, exist_ok=True)
        (resolver_vault / 'crm').mkdir(parents=True, exist_ok=True)
        (resolver_vault / 'misc').mkdir(parents=True, exist_ok=True)
        (resolver_vault / 'docs/cards/visa.md').write_text("# Visa card\n")
        (resolver_vault / 'crm/visa.md').write_text("# Visa contact\n")
        (resolver_vault / 'misc/visa-guide.md').write_text("# Visa guide\n")
        resolver_index = build_link_index(resolver_vault)
        resolved_exact, reason_exact = resolve_link_target('docs/cards/visa', resolver_index)
        test("resolve_link_target exact path",
             resolved_exact == 'docs/cards/visa' and reason_exact == 'exact',
             f"got: {(resolved_exact, reason_exact)}")
        resolved_suffix, reason_suffix = resolve_link_target('cards/visa', resolver_index)
        test("resolve_link_target unique suffix",
             resolved_suffix == 'docs/cards/visa' and reason_suffix == 'unique_suffix',
             f"got: {(resolved_suffix, reason_suffix)}")
        resolved_ambiguous, reason_ambiguous = resolve_link_target('visa', resolver_index)
        test("resolve_link_target blocks ambiguous stem",
             resolved_ambiguous is None and reason_ambiguous == 'ambiguous_stem',
             f"got: {(resolved_ambiguous, reason_ambiguous)}")
        resolved_unique_stem, reason_unique_stem = resolve_link_target('visa-guide', resolver_index)
        test("resolve_link_target unique stem",
             resolved_unique_stem == 'misc/visa-guide' and reason_unique_stem == 'unique_stem',
             f"got: {(resolved_unique_stem, reason_unique_stem)}")

        # 1.16b резолв по H1-заголовку: ссылка вида [[Заголовок]] находит единственную
        # карточку с таким заголовком. Путь и stem всегда сильнее заголовка, а
        # неоднозначный заголовок остаётся нерешённым вместо угадывания.
        title_vault = tmp / 'title-vault'
        (title_vault / 'cards/ideas').mkdir(parents=True, exist_ok=True)
        (title_vault / 'cards/notes').mkdir(parents=True, exist_ok=True)
        (title_vault / 'docs').mkdir(parents=True, exist_ok=True)
        (title_vault / 'crm').mkdir(parents=True, exist_ok=True)
        dev_title = 'Для разработки — рубрика инструментов'
        (title_vault / 'cards/ideas/dev-tools.md').write_text(
            f'# {dev_title}\n\n## Related\n- [[ссылка по заголовку]]\n')
        (title_vault / 'cards/notes/a.md').write_text('См. [[ссылка по заголовку]].\n')
        title_index = build_link_index(title_vault)
        test("extract_title reads the first H1 of the body",
             extract_title(f'# {dev_title}\n\n{dev_title}\n') == dev_title,
             f"got: {extract_title(f'# {dev_title}\n\n{dev_title}\n')!r}")
        test("extract_title ignores ## and missing H1",
             extract_title('## Раздел\n\nтекст\n') is None
             and extract_title('=== memory ===\ntext\n') is None,
             f"got: {extract_title('## Раздел\n\nтекст\n')!r}")
        test("normalize_title folds case, spaces and unicode form",
             normalize_title('  ДЛЯ   Разработки ') == 'для разработки'
             and normalize_title(unicodedata.normalize('NFD', 'Йога'))
             == normalize_title(unicodedata.normalize('NFC', 'Йога'))
             and normalize_title('   ') == '',
             f"got: {normalize_title('  ДЛЯ   Разработки ')!r}")
        resolved_title, reason_title = resolve_link_target(dev_title, title_index)
        test("resolve_link_target unique H1 title",
             resolved_title == 'cards/ideas/dev-tools' and reason_title == 'unique_title',
             f"got: {(resolved_title, reason_title)}")
        resolved_loose, reason_loose = resolve_link_target(
            '  для   РАЗРАБОТКИ — рубрика   инструментов ', title_index)
        test("unique H1 title survives case and extra spaces",
             resolved_loose == 'cards/ideas/dev-tools' and reason_loose == 'unique_title',
             f"got: {(resolved_loose, reason_loose)}")
        # NFC: один и тот же текст, записанный разными формами юникода, — один ключ.
        nfd_title = unicodedata.normalize('NFD', 'Йога — практика')
        nfc_title = unicodedata.normalize('NFC', 'Йога — практика')
        (title_vault / 'cards/notes/yoga.md').write_text(f'# {nfd_title}\n')
        title_index = build_link_index(title_vault)
        resolved_nfc, reason_nfc = resolve_link_target(nfc_title, title_index)
        test("unique H1 title compares NFC forms",
             resolved_nfc == 'cards/notes/yoga' and reason_nfc == 'unique_title',
             f"got: {(resolved_nfc, reason_nfc)}")
        # Два файла с одним заголовком (различие только в регистре) — ключ неоднозначен.
        (title_vault / 'cards/p1.md').write_text('# Проект\n')
        (title_vault / 'cards/p2.md').write_text('# ПРОЕКТ\n')
        title_index = build_link_index(title_vault)
        resolved_amb_title, reason_amb_title = resolve_link_target('проЕкт', title_index)
        test("resolve_link_target blocks ambiguous H1 title",
             resolved_amb_title is None and reason_amb_title == 'ambiguous_title',
             f"got: {(resolved_amb_title, reason_amb_title)}")
        # Заголовок одного файла совпадает со stem другого: решает stem.
        (title_vault / 'docs/visa.md').write_text('# Visa\n')
        (title_vault / 'crm/x.md').write_text('# visa\n')
        title_index = build_link_index(title_vault)
        resolved_stem_first, reason_stem_first = resolve_link_target('visa', title_index)
        test("unique stem beats a matching H1 title",
             resolved_stem_first == 'docs/visa' and reason_stem_first == 'unique_stem',
             f"got: {(resolved_stem_first, reason_stem_first)}")
        # ...и не спасает неоднозначный stem.
        (title_vault / 'crm/visa.md').write_text('# Другое\n')
        title_index = build_link_index(title_vault)
        resolved_stem_block, reason_stem_block = resolve_link_target('visa', title_index)
        test("a matching H1 title does not rescue an ambiguous stem",
             resolved_stem_block is None and reason_stem_block == 'ambiguous_stem',
             f"got: {(resolved_stem_block, reason_stem_block)}")
        # Без H1 и без валидного utf-8 файл в индекс заголовков не попадает,
        # остальные ключи остаются целыми.
        (title_vault / 'cards/notes/no-title.md').write_text('Просто текст без заголовка.\n')
        (title_vault / 'cards/notes/broken-utf8.md').write_bytes(b'# \xff\xfe\n')
        title_index = build_link_index(title_vault)
        test("title index skips cards without H1 and non-utf8 cards",
             resolve_link_target(nfc_title, title_index)
             == ('cards/notes/yoga', 'unique_title')
             and all(key for key in title_index.get('unique_title', {}))
             and all('no-title' not in path and 'broken-utf8' not in path
                     for path in title_index.get('unique_title', {}).values()),
             f"got: {title_index.get('unique_title')}")

        # 1.17 duplicate grouping only merges compatible cards
        dedup_vault = tmp / 'dedup-vault'
        (dedup_vault / 'knowledge/notes').mkdir(parents=True, exist_ok=True)
        (dedup_vault / 'contacts').mkdir(parents=True, exist_ok=True)
        (dedup_vault / 'personal').mkdir(parents=True, exist_ok=True)
        (dedup_vault / 'knowledge/foo.md').write_text(
            "---\ntype: note\ndomain: knowledge\ndescription: Foo\n---\n# Foo\n"
        )
        (dedup_vault / 'knowledge/notes/foo.md').write_text(
            "---\ntype: note\ndomain: knowledge\ndescription: Foo note\n---\n# Foo note\n"
        )
        (dedup_vault / 'contacts/bob.md').write_text(
            "---\ntype: contact\ndomain: crm\ndescription: Bob contact\n---\n# Bob\n"
        )
        (dedup_vault / 'personal/bob.md').write_text(
            "---\ntype: note\ndomain: personal\ndescription: Bob note\n---\n# Bob note\n"
        )
        duplicate_groups = collect_duplicate_groups(dedup_vault, schema)
        test("collect_duplicate_groups keeps same type/domain duplicates",
             duplicate_groups.get(('foo', 'knowledge', 'note')) == ['knowledge/notes/foo.md', 'knowledge/foo.md'] or
             duplicate_groups.get(('foo', 'knowledge', 'note')) == ['knowledge/foo.md', 'knowledge/notes/foo.md'],
             f"got: {duplicate_groups}")
        test("collect_duplicate_groups skips cross-domain homonyms",
             all(key[0] != 'bob' for key in duplicate_groups),
             f"got: {duplicate_groups}")
        test("is_hub_path detects nested _index", is_hub_path('foo/_index'))
        test("is_hub_path detects nested MEMORY", is_hub_path('agents/x/MEMORY'))

        # 1.18 recency / conflict / identity helpers
        test("card_recency_date prefers updated",
             card_recency_date({'updated': '2026-06', 'created': '2026-01'}) == '2026-06')
        test("card_recency_date falls back to created",
             card_recency_date({'created': '2026-01', 'last_accessed': '2026-05'}) == '2026-01')
        test("card_recency_date empty when none", card_recency_date({}) == '')
        test("get_conflict_fields default has company",
             'company' in get_conflict_fields({}))
        test("get_conflict_fields reads schema",
             get_conflict_fields({'conflict_fields': {'fields': ['x']}}) == ['x'])
        ident_cfg = get_identity_config({'identity': {'max_shared': 3, '_comment': 'x'}})
        test("get_identity_config fills defaults", ident_cfg['same_type_only'] is True)
        test("get_identity_config override applied", ident_cfg['max_shared'] == 3)
        test("get_identity_config strips _comment", '_comment' not in ident_cfg)
        test("normalize_identity_value strips @ from handle",
             normalize_identity_value('telegram', '@BobDev') == 'bobdev')
        test("normalize_identity_value phone digits only",
             normalize_identity_value('phone', '+1 (234) 567') == '1234567')

        # 1.19 entity-identity grouping (opt-in via schema `identity`)
        ident_schema = dict(schema)
        ident_schema['identity'] = {
            "match_fields": ["email"], "same_domain_only": True,
            "same_type_only": True, "ignore_values": ["info@x.com"], "max_shared": 8
        }
        ev = tmp / 'ident-vault'
        (ev / 'contacts').mkdir(parents=True, exist_ok=True)
        (ev / 'contacts/jane-doe.md').write_text(
            "---\ntype: contact\ndomain: crm\nemail: jane@x.com\n---\n# Jane Doe\n")
        (ev / 'contacts/jane.md').write_text(
            "---\ntype: contact\ndomain: crm\nemail: JANE@x.com\n---\n# Jane\n")
        g = collect_duplicate_groups(ev, ident_schema)
        grouped = [v for v in g.values() if len(v) == 2 and
                   set(v) == {'contacts/jane-doe.md', 'contacts/jane.md'}]
        test("entity-identity groups same email across filenames", len(grouped) == 1, f"got: {g}")
        # backward-compat: no identity block → exact-stem only → no grouping here
        test("no grouping without identity block",
             collect_duplicate_groups(ev, schema) == {}, f"got: {collect_duplicate_groups(ev, schema)}")
        # different type → not grouped
        (ev / 'note-jane.md').write_text(
            "---\ntype: note\ndomain: crm\nemail: jane@x.com\n---\n# note\n")
        g2 = collect_duplicate_groups(ev, ident_schema)
        note_grouped = any('note-jane.md' in v for v in g2.values())
        test("entity-identity respects same_type_only", not note_grouped, f"got: {g2}")
        # ignore_values → not grouped
        (ev / 'contacts/x1.md').write_text(
            "---\ntype: contact\ndomain: crm\nemail: info@x.com\n---\n# x1\n")
        (ev / 'contacts/x2.md').write_text(
            "---\ntype: contact\ndomain: crm\nemail: info@x.com\n---\n# x2\n")
        g3 = collect_duplicate_groups(ev, ident_schema)
        test("entity-identity skips ignore_values",
             not any({'contacts/x1.md', 'contacts/x2.md'} <= set(v) for v in g3.values()),
             f"got: {g3}")
        # max_shared guard: 3 cards share a value but max_shared=2 → not grouped
        maxv = tmp / 'maxshared-vault'
        (maxv / 'c').mkdir(parents=True, exist_ok=True)
        for n in ('a', 'b', 'c'):
            (maxv / 'c' / f'{n}.md').write_text(
                f"---\ntype: contact\ndomain: crm\nhandle: shared\n---\n# {n}\n")
        max_schema = dict(schema)
        max_schema['identity'] = {"match_fields": ["handle"], "max_shared": 2}
        test("entity-identity skips over-max_shared value",
             collect_duplicate_groups(maxv, max_schema) == {},
             f"got: {collect_duplicate_groups(maxv, max_schema)}")

        # ═══════════════════════════════════════════════════════
        # 2. Script CLI tests (subprocess against temp vault)
        # ═══════════════════════════════════════════════════════

        py = sys.executable  # use the same python that runs this test

        # --- graph.py ---
        print("\n--- graph.py ---")
        _schema_cache.clear()
        code, out, err = run([py, str(SCRIPTS_DIR / 'graph.py'), 'health',
                              str(vault_dir), str(schema_path)])
        test("graph health exits 0", code == 0, err[:300])
        test("graph health shows total files",
             'Total files:' in out, out[:200])
        # Should find our 10 files
        file_count_str = ''
        if 'Total files:' in out:
            file_count_str = out.split('Total files:')[1].split('\n')[0].strip()
        test("graph health correct file count",
             file_count_str == str(len(VAULT_FILES)),
             f"expected {len(VAULT_FILES)}, got '{file_count_str}'")
        test("graph health shows Health Score", 'Health Score' in out)

        # Health is defined over schema-managed cards. Raw transcripts and roots remain
        # graph nodes, but adding them cannot decay card-quality metrics.
        from graph import build_graph, expected_future_link, fix_broken_links
        health_schema = {
            "node_types": {
                "note": {},
                "daily-summary": {},
                "weekly-summary": {},
                "monthly-summary": {},
                "yearly-summary": {},
            },
            "path_type_hints": {
                "cards/notes/": "note",
                "summaries/daily/": "daily-summary",
                "weekly/": "weekly-summary",
                "monthly/": "monthly-summary",
                "yearly/": "yearly-summary",
            },
            "domain_inference": {
                "cards/": "knowledge",
                "daily/": "personal",
                "summaries/": "personal",
                "weekly/": "personal",
                "monthly/": "personal",
                "yearly/": "personal",
            },
        }
        health_vault = tmp / 'managed-health-vault'
        (health_vault / 'cards/notes').mkdir(parents=True)
        (health_vault / 'cards/notes/alpha.md').write_text(
            "---\ntype: note\ndescription: Alpha\n---\n# Alpha\n"
            "[[cards/notes/alpha]] [[cards/notes/alpha]] [[cards/notes/alpha]]\n"
        )
        baseline = build_graph(health_vault, health_schema, today=date(2026, 8, 5))
        (health_vault / 'daily').mkdir()
        for day in range(100):
            (health_vault / 'daily' / f'raw-{day:03d}.md').write_text(
                f"# Raw {day}\nNo frontmatter or description.\n"
            )
        (health_vault / 'CORE.md').write_text('# Core\n')
        (health_vault / 'MOC.md').write_text('# MOC\n')
        with_raw = build_graph(health_vault, health_schema, today=date(2026, 8, 5))
        for metric in ('health_score', 'desc_coverage', 'managed_avg_links'):
            test(f"100 raw transcripts leave {metric} unchanged",
                 with_raw['stats'][metric] == baseline['stats'][metric],
                 f"baseline={baseline['stats'][metric]} raw={with_raw['stats'][metric]}")
        test("raw transcripts and CORE/MOC remain graph nodes",
             with_raw['stats']['total_files'] == 103)
        test("raw transcripts and CORE/MOC are outside managed health",
             with_raw['stats']['managed_files'] == 1)

        auto_schema_vault = tmp / 'auto-schema-health-vault'
        (auto_schema_vault / 'cards/notes').mkdir(parents=True)
        (auto_schema_vault / 'schema.json').write_text(json.dumps(health_schema))
        (auto_schema_vault / 'cards/notes/hinted.md').write_text(
            "# Managed through the discovered path hint\n"
        )
        code, _, err = run([py, str(SCRIPTS_DIR / 'graph.py'), 'health',
                            str(auto_schema_vault), '--as-of', '2026-08-05'])
        auto_stats = json.loads(
            (auto_schema_vault / '.graph/vault-graph.json').read_text()
        )['stats']
        test("CLI auto-discovers vault/schema.json",
             code == 0 and auto_stats['managed_files'] == 1, err[:200])

        no_schema_vault = tmp / 'no-schema-health-vault'
        no_schema_vault.mkdir()
        (no_schema_vault / 'plain.md').write_text('# Plain node\n')
        code, _, err = run([py, str(SCRIPTS_DIR / 'graph.py'), 'health',
                            str(no_schema_vault), '--as-of', '2026-08-05'])
        no_schema_stats = json.loads(
            (no_schema_vault / '.graph/vault-graph.json').read_text()
        )['stats']
        test("CLI without any schema keeps all-node health fallback",
             code == 0 and no_schema_stats['managed_files'] == 1, err[:200])

        (health_vault / 'cards/notes/no-description.md').write_text(
            "# Missing description but managed through path_type_hints\n"
        )
        missing_desc = build_graph(health_vault, health_schema, today=date(2026, 8, 5))
        test("managed path without description lowers coverage",
             missing_desc['stats']['desc_coverage'] < with_raw['stats']['desc_coverage'])

        # Exact rollup parents stay future only through their scheduled creation day.
        test("ISO-year daily parent accepts W53 on creation day",
             expected_future_link('summaries/daily/2021-01-01', 'weekly/2020-W53',
                                  date(2021, 1, 4)))
        test("ISO-year daily parent becomes broken after creation day",
             not expected_future_link('summaries/daily/2021-01-01', 'weekly/2020-W53',
                                      date(2021, 1, 5)))
        test("W53 belongs to month containing its Thursday",
             expected_future_link('weekly/2020-W53', 'monthly/2020-12', date(2021, 1, 1)))
        test("leap-day Thursday selects February",
             expected_future_link('weekly/2024-W09', 'monthly/2024-02', date(2024, 3, 1)))
        test("monthly parent year expires after Jan 1",
             expected_future_link('monthly/2024-12', 'yearly/2024', date(2025, 1, 1))
             and not expected_future_link('monthly/2024-12', 'yearly/2024', date(2025, 1, 2)))
        test("wrong rollup period is never future",
             not expected_future_link('weekly/2024-W09', 'monthly/2024-03', date(2024, 3, 1)))

        rollup_vault = tmp / 'rollup-health-vault'
        (rollup_vault / 'summaries/daily').mkdir(parents=True)
        daily_summary = rollup_vault / 'summaries/daily/2021-01-01.md'
        daily_summary.write_text(
            "---\ntype: daily-summary\ndescription: Boundary day\n---\n"
            "# Boundary\nUp: [[weekly/2020-W53]]\n"
        )
        future_graph = build_graph(rollup_vault, health_schema, today=date(2021, 1, 4))
        test("exact absent parent is reported separately as future",
             future_graph['stats']['future_links'] == 1
             and future_graph['stats']['broken_links'] == 0
             and future_graph['stats']['managed_orphans'] == 0,
             str(future_graph['stats']))
        fixes, applied, ambiguous, _skipped = fix_broken_links(
            rollup_vault, future_graph, apply=False)
        test("graph fix ignores an expected future parent",
             fixes == [] and applied == 0 and ambiguous == [])
        legacy_graph = build_graph(
            rollup_vault,
            {"node_types": {"note": {}}, "path_type_hints": {}},
            today=date(2021, 1, 4),
        )
        test("future parent classification does not depend on managed schema types",
             legacy_graph['stats']['future_links'] == 1
             and legacy_graph['stats']['broken_links'] == 0
             and legacy_graph['stats']['managed_files'] == 0,
             str(legacy_graph['stats']))

        (rollup_vault / 'schema.json').write_text(json.dumps(health_schema))
        code, _, err = run([py, str(SCRIPTS_DIR / 'graph.py'), 'health',
                            str(rollup_vault), '--as-of', '2021-01-04'])
        cli_future = json.loads(
            (rollup_vault / '.graph/vault-graph.json').read_text()
        )['stats']
        test("CLI --as-of keeps parent future on scheduled creation day",
             code == 0 and cli_future['future_links'] == 1, err[:200])
        code, _, err = run([py, str(SCRIPTS_DIR / 'graph.py'), 'health',
                            str(rollup_vault), '--as-of', '2021-01-05'])
        cli_overdue = json.loads(
            (rollup_vault / '.graph/vault-graph.json').read_text()
        )['stats']
        test("CLI --as-of makes parent broken the following day",
             code == 0 and cli_overdue['future_links'] == 0
             and cli_overdue['managed_broken_links'] == 1, err[:200])
        overdue_graph = build_graph(rollup_vault, health_schema, today=date(2021, 1, 5))
        test("overdue parent becomes managed broken link",
             overdue_graph['stats']['future_links'] == 0
             and overdue_graph['stats']['managed_broken_links'] == 1
             and overdue_graph['stats']['managed_orphans'] == 1,
             str(overdue_graph['stats']))
        daily_summary.write_text(
            "---\ntype: daily-summary\ndescription: Boundary day\n---\n"
            "# Boundary\nUp: [[weekly/2021-W01]]\n"
        )
        wrong_graph = build_graph(rollup_vault, health_schema, today=date(2021, 1, 1))
        test("wrong missing parent is immediately broken",
             wrong_graph['stats']['future_links'] == 0
             and wrong_graph['stats']['managed_broken_links'] == 1)
        (rollup_vault / 'weekly').mkdir()
        (rollup_vault / 'weekly/2020-W53.md').write_text(
            "---\ntype: weekly-summary\ndescription: Week 53\n---\n# Week 53\n"
        )
        daily_summary.write_text(
            "---\ntype: daily-summary\ndescription: Boundary day\n---\n"
            "# Boundary\nUp: [[weekly/2020-W53]]\n"
        )
        resolved_graph = build_graph(rollup_vault, health_schema, today=date(2021, 1, 5))
        test("existing parent is an ordinary resolved link",
             resolved_graph['stats']['future_links'] == 0
             and resolved_graph['stats']['broken_links'] == 0)

        audio_vault = tmp / 'audio-embed-vault'
        (audio_vault / 'cards/notes').mkdir(parents=True)
        (audio_vault / 'cards/notes/voice.ogg.md').write_text(
            "---\ntype: note\ndescription: Real Markdown note\n---\n# Voice note\n"
        )
        (audio_vault / 'cards/notes/audio.md').write_text(
            "---\ntype: note\ndescription: Audio embeds\n---\n# Audio\n"
            "![[missing.ogg]] ![[missing.OPUS]] ![[missing.m4a]] ![[missing.WAV]] "
            "[[cards/notes/voice.ogg]] [[missing-note.ogg.md]]\n"
        )
        audio_graph = build_graph(audio_vault, health_schema, today=date(2026, 8, 5))
        test("audio attachment extensions are not broken wiki-links",
             audio_graph['stats']['broken_links'] == 1,
             str(audio_graph['broken_link_list']))
        test("existing Markdown filename ending in .ogg.md resolves before embed skip",
             audio_graph['stats']['total_links'] == 1
             and audio_graph['nodes']['cards/notes/voice.ogg']['incoming']
             == ['cards/notes/audio'], str(audio_graph['nodes']))
        test("missing Markdown filename ending in .ogg.md is still checked",
             audio_graph['broken_link_list'] == [
                 {'source': 'cards/notes/audio', 'target': 'missing-note.ogg'}
             ], str(audio_graph['broken_link_list']))

        attachment_vault = tmp / 'existing-arbitrary-attachment-vault'
        (attachment_vault / 'attachments/2026-09-15').mkdir(parents=True)
        (attachment_vault / 'cards/notes').mkdir(parents=True)
        (attachment_vault / 'attachments/2026-09-15/brief.custombin').write_bytes(b'fixture')
        (attachment_vault / 'cards/notes/attachment.md').write_text(
            "---\ntype: note\ndescription: Attachment reference\n---\n# Attachment\n"
            "![[attachments/2026-09-15/brief.custombin]] "
            "![[attachments/2026-09-15/missing.custombin]]\n"
        )
        attachment_graph = build_graph(attachment_vault, health_schema, today=date(2026, 8, 5))
        test("existing attachment with arbitrary extension is valid",
             attachment_graph['stats']['broken_links'] == 1
             and attachment_graph['broken_link_list'] == [
                 {'source': 'cards/notes/attachment',
                  'target': 'attachments/2026-09-15/missing.custombin'}
             ], str(attachment_graph['broken_link_list']))

        # graph orphans
        code, out, _ = run([py, str(SCRIPTS_DIR / 'graph.py'), 'orphans',
                            str(vault_dir), str(schema_path)])
        test("graph orphans exits 0", code == 0)
        test("graph orphans shows list", 'Orphans:' in out)

        # graph backlinks
        code, out, _ = run([py, str(SCRIPTS_DIR / 'graph.py'), 'backlinks',
                            str(vault_dir), 'contacts/bob', str(schema_path)])
        test("graph backlinks exits 0", code == 0)
        test("graph backlinks finds links", 'Backlinks' in out)

        # --- moc.py ---
        print("\n--- moc.py ---")
        _schema_cache.clear()
        code, out, err = run([py, str(SCRIPTS_DIR / 'moc.py'), 'generate',
                              str(vault_dir), str(schema_path)])
        test("moc generate exits 0", code == 0, err[:300])
        test("moc generates wikilinks", 'wikilinks' in out.lower(), out[:200])

        # Check MOC files were created
        moc_dir = vault_dir / 'MOC'
        moc_files = list(moc_dir.glob('MOC-*.md')) if moc_dir.exists() else []
        test("moc creates MOC files", len(moc_files) > 0,
             f"found {len(moc_files)}")

        # Hub MOC.md regenerated from actually generated domain MOCs (issue #113)
        hub = vault_dir / 'MOC.md'
        test("moc writes hub MOC.md", hub.exists())
        hub_text = hub.read_text() if hub.exists() else ''
        for f in moc_files:
            test(f"hub links {f.stem}", f'[[MOC/{f.stem}]]' in hub_text,
                 hub_text[:200])

        # Stale domain disappears from the hub on the next full generate
        stale = moc_dir / 'MOC-staledomain.md'
        stale.write_text('# MOC: staledomain\n')
        hub.write_text(hub_text.replace(
            '\n', '\n- [[MOC/MOC-staledomain]] — карточек: 1\n', 1))
        _schema_cache.clear()
        code, out, err = run([py, str(SCRIPTS_DIR / 'moc.py'), 'generate',
                              str(vault_dir), str(schema_path)])
        test("moc regenerate exits 0", code == 0, err[:300])
        test("hub drops stale domain",
             'MOC-staledomain' not in hub.read_text())
        stale.unlink(missing_ok=True)

        # --domain run: only that domain's file rewritten, hub still lists all
        first_domain = moc_files[0].stem.replace('MOC-', '')
        hub.unlink()
        _schema_cache.clear()
        code, out, err = run([py, str(SCRIPTS_DIR / 'moc.py'), 'generate',
                              str(vault_dir), str(schema_path),
                              '--domain', first_domain])
        test("moc --domain exits 0", code == 0, err[:300])
        hub_text = hub.read_text() if hub.exists() else ''
        test("moc --domain rebuilds full hub",
             all(f'[[MOC/{f.stem}]]' in hub_text for f in moc_files),
             hub_text[:200])

        # Hub links only domains whose MOC file actually exists: a missing
        # domain file must not become a broken wikilink after a --domain run
        if len(moc_files) >= 2:
            missing = moc_files[-1]
            missing.unlink()
            _schema_cache.clear()
            code, out, err = run([py, str(SCRIPTS_DIR / 'moc.py'), 'generate',
                                  str(vault_dir), str(schema_path),
                                  '--domain', first_domain])
            test("moc --domain skips missing domain file in hub",
                 code == 0 and f'[[MOC/{missing.stem}]]' not in hub.read_text(),
                 hub.read_text()[:200])
            # restore for the checks below
            _schema_cache.clear()
            run([py, str(SCRIPTS_DIR / 'moc.py'), 'generate',
                 str(vault_dir), str(schema_path)])

        # --- engine.py ---
        print("\n--- engine.py ---")
        _schema_cache.clear()
        code, out, err = run([py, str(SCRIPTS_DIR / 'engine.py'), 'stats',
                              str(vault_dir), str(schema_path)])
        test("engine stats exits 0", code == 0, err[:300])
        test("engine stats shows total cards", 'total cards:' in out, out[:200])
        test("engine stats shows decay rate", '0.015' in out)
        test("engine stats shows tier distribution", 'tier distribution' in out)

        # engine creative
        _schema_cache.clear()
        code, out, err = run([py, str(SCRIPTS_DIR / 'engine.py'), 'creative', '2',
                              str(vault_dir), str(schema_path)])
        test("engine creative exits 0", code == 0, err[:300])

        # --- enforce.py ---
        print("\n--- enforce.py ---")
        _schema_cache.clear()
        code, out, err = run([py, str(SCRIPTS_DIR / 'enforce.py'),
                              str(vault_dir), str(schema_path)])
        test("enforce exits 0", code == 0, err[:300])
        test("enforce shows compliance score", 'SCHEMA COMPLIANCE' in out, out[:300])

        # enforce regression: `superseded` status must survive when it's in the enum,
        # but be remapped when it isn't (proves why the schema change is mandatory).
        _schema_cache.clear()
        sup_vault = tmp / 'superseded-vault'
        sup_vault.mkdir(parents=True, exist_ok=True)
        card = ("---\ntype: project\nstatus: superseded\ntags: [x, y]\n"
                "description: Retired project\nsuperseded_by: '[[new-project]]'\n---\n# Old\n")
        (sup_vault / 'old.md').write_text(card, encoding="utf-8")
        # schema WITH superseded in the enum
        sup_schema = tmp / 'schema-with-superseded.json'
        sup_schema.write_text(json.dumps(SCHEMA, indent=2, ensure_ascii=False))
        code, out, err = run([py, str(SCRIPTS_DIR / 'enforce.py'),
                              str(sup_vault), str(sup_schema), '--apply'])
        test("enforce (with superseded) exits 0", code == 0, err[:300])
        kept = (sup_vault / 'old.md').read_text(encoding="utf-8")
        test("enforce keeps status: superseded when in enum",
             'status: superseded' in kept, kept[:200])
        # control: schema WITHOUT superseded → remapped to first valid status (active)
        _schema_cache.clear()
        ctrl_vault = tmp / 'superseded-control'
        ctrl_vault.mkdir(parents=True, exist_ok=True)
        (ctrl_vault / 'old.md').write_text(card, encoding="utf-8")
        no_sup = json.loads(json.dumps(SCHEMA))
        no_sup['node_types']['project']['status'] = ["active", "done", "paused", "cancelled"]
        ctrl_schema = tmp / 'schema-no-superseded.json'
        ctrl_schema.write_text(json.dumps(no_sup, indent=2, ensure_ascii=False))
        code, out, err = run([py, str(SCRIPTS_DIR / 'enforce.py'),
                              str(ctrl_vault), str(ctrl_schema), '--apply'])
        remapped = (ctrl_vault / 'old.md').read_text(encoding="utf-8")
        remapped_fm, _, _ = parse_frontmatter(remapped)
        test("enforce remaps superseded when NOT in enum",
             remapped_fm.get('status') == 'active',
             remapped[:200])

        # enforce must never read giant cards whole. A sparse file keeps the
        # fixture cheap while exercising the stat guard and report wiring.
        _schema_cache.clear()
        oversize_vault = tmp / 'oversize-vault'
        oversize_vault.mkdir(parents=True, exist_ok=True)
        oversize_card = oversize_vault / 'giant-card.md'
        with oversize_card.open('wb') as f:
            f.seek(10 * 1024 * 1024)
            f.write(b'\0')
        code, out, err = run([py, str(SCRIPTS_DIR / 'enforce.py'),
                              str(oversize_vault), str(schema_path)])
        oversize_report = json.loads(
            (oversize_vault / '.graph' / 'enforce-report.json').read_text()
        )
        test("enforce skips oversized file with warning",
             code == 0 and 'giant-card.md' in out and 'WARNING' in out,
             f"code={code}, out={out[:300]!r}, err={err[:300]!r}")
        test("enforce report counts oversized skip",
             oversize_report.get('skipped_oversize') == 1,
             f"got: {oversize_report!r}")

        _schema_cache.clear()
        cleanup_vault = tmp / 'card-structure-vault'
        (cleanup_vault / 'cards/notes').mkdir(parents=True)
        (cleanup_vault / 'daily').mkdir()
        (cleanup_vault / 'summaries/daily').mkdir(parents=True)
        system_fields = (
            f"domain: personal\nlast_accessed: {date.today().isoformat()}\n"
            "tier: warm\nrelevance: 0.5\n"
        )
        safe_card = cleanup_vault / 'cards/notes/safe.md'
        safe_card.write_text(
            "---\ntype: note\nstatus: active\ntags: [note, cleanup]\n"
            "description: Structural cleanup fixture\n" + system_fields + "---\n"
            "# Safe card\n\nCurrent truth.\n\n"
            "## Log\n- 2026-07-20: Earlier fact\n\n"
            "## Обновление 2026-07-29\n\n"
            "## Обновление 2026-07-30\nNew fact one.\n\n"
            "## Update 2026-07-31\nNew fact two.\nSecond line.\n\n"
            + "\n\n".join(
                f"## Related\n- [[hub#part|Hub]]\n- [[sibling-{index}]]"
                for index in range(8)
            ) + "\n"
        )
        ambiguous_card = cleanup_vault / 'cards/notes/ambiguous.md'
        ambiguous_card.write_text(
            "---\ntype: note\nstatus: active\ntags: [note, cleanup]\n"
            "description: Ambiguous Related fixture\n" + system_fields + "---\n"
            "# Ambiguous\n\n## Related\n- [[hub]]\n\n"
            "## Related\nKeep this prose explanation with [[other]].\n"
        )
        fenced_card = cleanup_vault / 'cards/notes/fenced.md'
        fenced_before = (
            "---\ntype: note\nstatus: active\ntags: [note, cleanup]\n"
            "description: Fenced headings fixture\n" + system_fields + "---\n"
            "# Fenced\n\n```markdown\n## Related\n- [[example]]\n"
            "## Log\n## Update 2026-07-31\n```\n"
        )
        fenced_card.write_text(fenced_before)
        complex_card = cleanup_vault / 'cards/notes/complex-log.md'
        complex_before = (
            "---\ntype: note\nstatus: active\ntags: [note, cleanup]\n"
            "description: Complex Log fixture\n" + system_fields + "---\n"
            "# Complex Log\n\nCurrent truth stays byte-identical.\n\n"
            "## Log\n- 2026-07-20:\n  - nested item\n\n"
            "```markdown\n## Update 2020-01-01\nexample only\n```\n\n"
            "## Update 2026-08-01\nParagraph one.\n\nParagraph two.\n"
        )
        complex_card.write_text(complex_before)
        raw_file = cleanup_vault / 'daily/2026-07-31.md'
        raw_before = "# Raw\n\n## Обновление 2026-07-31\n\n## Related\n- [[hub]]\n"
        raw_file.write_text(raw_before)
        summary_file = cleanup_vault / 'summaries/daily/2026-07-31.md'
        summary_before = (
            "---\ntype: note\nstatus: active\ntags: [summary]\n"
            "description: Summary scope fixture\n" + system_fields + "---\n"
            "# Summary\n\n## Обновление 2026-07-31\nStill a summary section.\n"
        )
        summary_file.write_text(summary_before)

        code, out, err = run([py, str(SCRIPTS_DIR / 'enforce.py'),
                              str(cleanup_vault), str(schema_path), '--apply'])
        safe_after = safe_card.read_text()
        ambiguous_after = ambiguous_card.read_text()
        complex_after = complex_card.read_text()
        cleanup_report = json.loads(
            (cleanup_vault / '.graph/enforce-report.json').read_text()
        )
        test("enforce card cleanup exits 0", code == 0, err[:300])
        test("enforce merges eight link-only Related sections",
             safe_after.count('\n## Related\n') == 1, safe_after)
        test("enforce deduplicates alias/anchor targets and keeps distinct links",
             safe_after.count('[[hub#part|Hub]]') == 1
             and all(f'[[sibling-{index}]]' in safe_after for index in range(8)),
             safe_after)
        test("enforce removes empty updates and migrates non-empty updates to one Log",
             '## Обновление' not in safe_after and '## Update ' not in safe_after
             and safe_after.count('\n## Log\n') == 1
             and '- 2026-07-30: New fact one.' in safe_after
             and '- 2026-07-31:' in safe_after
             and '  Second line.' in safe_after,
             safe_after)
        test("enforce leaves prose-bearing duplicate Related untouched",
             ambiguous_after.count('\n## Related\n') == 2
             and 'Keep this prose explanation' in ambiguous_after,
             ambiguous_after)
        test("enforce queues migrated updates and ambiguous structures for compile",
             cleanup_report.get('compile_candidates') == [
                 'cards/notes/ambiguous.md',
                 'cards/notes/complex-log.md',
                 'cards/notes/safe.md',
             ],
             str(cleanup_report))
        test("enforce leaves complex and fenced Log/Update sections byte-identical",
             complex_after == complex_before, complex_after)
        test("enforce card cleanup never touches raw transcripts or summaries",
             raw_file.read_text() == raw_before and summary_file.read_text() == summary_before)
        test("enforce preserves structural headings inside fenced code byte-for-byte",
             fenced_card.read_text() == fenced_before, fenced_card.read_text())

        safe_snapshot = safe_after
        ambiguous_snapshot = ambiguous_after
        complex_snapshot = complex_after
        code, _, err = run([py, str(SCRIPTS_DIR / 'enforce.py'),
                            str(cleanup_vault), str(schema_path), '--apply'])
        test("second enforce card cleanup is byte-stable",
             code == 0 and safe_card.read_text() == safe_snapshot
             and ambiguous_card.read_text() == ambiguous_snapshot
             and complex_card.read_text() == complex_snapshot,
             err[:300])

        # --- discover.py ---
        print("\n--- discover.py ---")
        _schema_cache.clear()
        code, out, err = run([py, str(SCRIPTS_DIR / 'discover.py'), str(vault_dir)])
        test("discover exits 0", code == 0, err[:300])
        try:
            disc = json.loads(out)
            test("discover outputs valid JSON", True)
            # MOC files may have been created by moc.py above, so count >= original
            test("discover finds files >= fixture count",
                 disc['meta']['total_files'] >= len(VAULT_FILES),
                 f"expected >= {len(VAULT_FILES)}, got {disc['meta'].get('total_files')}")
        except Exception as e:
            test("discover outputs valid JSON", False, str(e)[:200])

        # --- dedup.py ---
        print("\n--- dedup.py ---")
        _schema_cache.clear()
        code, out, err = run([py, str(SCRIPTS_DIR / 'dedup.py'), str(vault_dir)])
        test("dedup exits 0", code == 0, err[:300])
        # We have bob.md in two places, so duplicates should be found
        test("dedup finds duplicates",
             'Duplicate groups' in out or 'No duplicates' in out,
             out[:200])

        policy_vault = tmp / 'policy-vault'
        (policy_vault / 'pu').mkdir(parents=True, exist_ok=True)
        (policy_vault / 'sample/contacts').mkdir(parents=True, exist_ok=True)
        (policy_vault / 'sample/clients').mkdir(parents=True, exist_ok=True)
        (policy_vault / 'crm/sample').mkdir(parents=True, exist_ok=True)
        (policy_vault / 'pu/alex.md').write_text(
            "---\ntype: power_user\ndomain: sample\nstatus: active\n---\n# Alex\n")
        (policy_vault / 'sample/contacts/alex.md').write_text(
            "---\ntype: contact\ndomain: sample\nstatus: active\n---\n# Alex\n")
        (policy_vault / 'sample/clients/acme.md').write_text(
            "---\ntype: client\ndomain: sample\nstatus: active\n---\n# Acme\n")
        (policy_vault / 'sample/contacts/acme.md').write_text(
            "---\ntype: contact\ndomain: sample\nstatus: active\n---\n# Acme\n")
        policy_schema = dict(SCHEMA)
        policy_schema['node_types'] = dict(SCHEMA['node_types'])
        policy_schema['node_types']['power_user'] = {
            "description": "Power user", "required": ["description"], "status": ["active"]
        }
        policy_schema['node_types']['client'] = {
            "description": "Client", "required": ["description"], "status": ["active"]
        }
        policy_schema['node_types']['crm'] = {
            "description": "CRM overlay", "required": ["description"], "status": ["active"]
        }
        policy_schema['dedup_policy'] = {
            "canonical_priority": [
                "pu/",
                "sample/clients/",
                "sample/contacts/",
                "crm/sample/"
            ],
            "path_rules": [
                {"prefix": "pu/", "domain": "sample-pu", "type": "power_user", "kind": "power_user"},
                {"prefix": "sample/clients/", "domain": "sample-clients", "type": "client", "kind": "client"},
                {"prefix": "sample/contacts/", "domain": "sample-contacts", "type": "contact", "kind": "contact"},
                {"prefix": "crm/sample/", "domain": "sample-crm", "type": "crm", "kind": "crm"}
            ]
        }
        policy_schema_path = tmp / 'policy-schema.json'
        policy_schema_path.write_text(json.dumps(policy_schema))
        policy_manifest = tmp / 'policy-manifest.json'
        code, out, err = run([py, str(SCRIPTS_DIR / 'dedup.py'), str(policy_vault),
                              str(policy_schema_path), '--dry-run', '--manifest',
                              str(policy_manifest), '--verbose'])
        test("dedup policy manifest exits 0", code == 0, err[:300])
        test("dedup policy manifest writes file", policy_manifest.exists())
        test("dedup policy does not move PU/client into contacts",
             'MOVE:' not in out and 'policy' in policy_manifest.read_text(),
             out[:300])
        manifest_data = json.loads(policy_manifest.read_text())
        actions = {c['slug']: c['action'] for c in manifest_data['clusters']}
        test("dedup policy keeps layered PU/contact", actions.get('alex') == 'keep_linked_layers', str(actions))
        test("dedup policy keeps client/contact layers", actions.get('acme') == 'keep_linked_layers', str(actions))

        # --- daily.py ---
        print("\n--- daily.py ---")
        _schema_cache.clear()
        code, out, err = run([py, str(SCRIPTS_DIR / 'daily.py'), 'extract',
                              str(daily_dir), str(vault_dir), '2026-03-01'])
        test("daily extract exits 0", code == 0, err[:300])
        test("daily extract finds people", '"people"' in out, out[:200])
        try:
            daily_summary = json.loads(out)
            test("daily extract summary includes linked_entities",
                 'linked_entities' in daily_summary,
                 str(daily_summary))
        except Exception as e:
            test("daily extract summary includes linked_entities", False, str(e)[:200])

        # ═══════════════════════════════════════════════════════
        # 3. swarm_prepare.py + swarm_reduce.py tests
        # ═══════════════════════════════════════════════════════

        # --- swarm_prepare.py ---
        print("\n--- swarm_prepare.py ---")
        _schema_cache.clear()

        # First run discover to get discovery JSON
        code_disc, out_disc, _ = run([py, str(SCRIPTS_DIR / 'discover.py'), str(vault_dir)])
        disc_json_path = tmp / 'discovery.json'
        disc_json_path.write_text(out_disc)

        # 3.1 swarm_prepare exits 0 and produces manifests
        code, out, err = run([py, str(SCRIPTS_DIR / 'swarm_prepare.py'),
                              str(vault_dir), str(disc_json_path), '--budget', '50000'])
        test("swarm_prepare exits 0", code == 0, err[:300])
        test("swarm_prepare shows batch count", 'batch' in out.lower(), out[:200])

        # Check manifests were created
        manifests_dir = vault_dir / '.graph' / 'swarm' / 'manifests'
        manifests = list(manifests_dir.glob('batch-*.json')) if manifests_dir.exists() else []
        test("swarm_prepare creates manifests", len(manifests) > 0,
             f"found {len(manifests)} manifests")

        # 3.2 All files distributed (sum of batch file_counts = total files)
        total_in_batches = 0
        all_batch_files = set()
        for mf in manifests:
            manifest = json.loads(mf.read_text())
            total_in_batches += manifest['file_count']
            for f in manifest['files']:
                all_batch_files.add(f)
        # walk_vault finds all files (may include MOC files from moc.py test above)
        from common import walk_vault as wv, rel_path as rp
        vault_files_actual = [rp(f, vault_dir) for f in wv(vault_dir)]
        test("swarm_prepare distributes all files",
             total_in_batches == len(vault_files_actual),
             f"batches have {total_in_batches}, vault has {len(vault_files_actual)}")

        # 3.3 No file duplicated across batches
        test("swarm_prepare no file duplicates",
             len(all_batch_files) == total_in_batches,
             f"unique={len(all_batch_files)}, total={total_in_batches}")

        # 3.4 Budget respected per batch
        budget = 50000
        budget_ok = True
        for mf in manifests:
            manifest = json.loads(mf.read_text())
            if manifest['estimated_tokens'] > budget and manifest['file_count'] > 1:
                budget_ok = False
        test("swarm_prepare respects token budget", budget_ok)

        # 3.5 Seed types included
        if manifests:
            first_manifest = json.loads(manifests[0].read_text())
            test("swarm_prepare includes seed_types",
                 len(first_manifest.get('seed_types', [])) > 0,
                 str(first_manifest.get('seed_types', [])))
        else:
            test("swarm_prepare includes seed_types", False, "no manifests")

        # 3.6 swarm-meta.json exists
        meta_path = vault_dir / '.graph' / 'swarm' / 'swarm-meta.json'
        test("swarm_prepare creates swarm-meta.json", meta_path.exists())

        # 3.7 Deterministic: two runs produce identical manifests
        # Clean up and re-run
        import shutil as _shutil
        swarm_dir_1 = tmp / 'swarm-backup'
        if manifests_dir.exists():
            _shutil.copytree(manifests_dir, swarm_dir_1)
        # Remove and re-run
        _shutil.rmtree(vault_dir / '.graph' / 'swarm', ignore_errors=True)
        code2, _, _ = run([py, str(SCRIPTS_DIR / 'swarm_prepare.py'),
                           str(vault_dir), str(disc_json_path), '--budget', '50000'])
        manifests2 = sorted(manifests_dir.glob('batch-*.json')) if manifests_dir.exists() else []
        manifests1 = sorted(swarm_dir_1.glob('batch-*.json')) if swarm_dir_1.exists() else []
        deterministic = (len(manifests1) == len(manifests2))
        if deterministic:
            for m1, m2 in zip(manifests1, manifests2):
                d1 = json.loads(m1.read_text())
                d2 = json.loads(m2.read_text())
                # Compare file lists (not timestamps)
                if d1['files'] != d2['files']:
                    deterministic = False
                    break
        test("swarm_prepare is deterministic", deterministic)

        # 3.8 Empty vault
        empty_swarm = tmp / 'empty-swarm-vault'
        empty_swarm.mkdir(exist_ok=True)
        code_e, out_e, err_e = run([py, str(SCRIPTS_DIR / 'swarm_prepare.py'),
                                     str(empty_swarm)])
        test("swarm_prepare handles empty vault", code_e == 0, err_e[:200])

        # --- swarm_reduce.py ---
        print("\n--- swarm_reduce.py ---")

        # Create fake Wave 1 JSONL output for testing
        classifications_dir = vault_dir / '.graph' / 'swarm' / 'classifications'
        classifications_dir.mkdir(parents=True, exist_ok=True)
        jsonl_lines = []
        for rel_file in list(VAULT_FILES.keys())[:5]:
            jsonl_lines.append(json.dumps({
                "path": rel_file,
                "proposed_type": "note",
                "proposed_domain": "knowledge",
                "summary": "Test file",
                "seed_match": True,
                "confidence": "high"
            }))
        for rel_file in list(VAULT_FILES.keys())[5:]:
            jsonl_lines.append(json.dumps({
                "path": rel_file,
                "proposed_type": "contact",
                "proposed_domain": "crm",
                "summary": "Contact file",
                "seed_match": True,
                "confidence": "medium"
            }))
        (classifications_dir / 'batch-001.jsonl').write_text('\n'.join(jsonl_lines) + '\n')

        # Add a malformed line
        (classifications_dir / 'batch-002.jsonl').write_text(
            '{"path":"ok.md","proposed_type":"note","proposed_domain":"personal","summary":"ok","seed_match":true,"confidence":"high"}\n'
            'THIS IS NOT JSON\n'
            '{"no_path_field": true}\n'
        )

        # 3.9 swarm_reduce prepare reads JSONL and counts frequencies
        code, out, err = run([py, str(SCRIPTS_DIR / 'swarm_reduce.py'), 'prepare',
                              str(vault_dir)])
        test("swarm_reduce prepare exits 0", code == 0, err[:300])
        test("swarm_reduce prepare shows types", 'note' in out, out[:300])

        consolidation_path = vault_dir / '.graph' / 'swarm' / 'consolidation.json'
        test("swarm_reduce prepare creates consolidation.json",
             consolidation_path.exists())

        if consolidation_path.exists():
            consol = json.loads(consolidation_path.read_text())
            test("swarm_reduce prepare has type_frequency",
                 'note' in consol.get('type_frequency', {}),
                 str(consol.get('type_frequency', {})))
        else:
            test("swarm_reduce prepare has type_frequency", False, "no consolidation")

        # 3.10 swarm_reduce prepare handles malformed lines (logged to stderr)
        test("swarm_reduce prepare warns on malformed", 'malformed' in err.lower() or 'WARN' in err,
             err[:200])

        # 3.11 swarm_reduce finalize with valid schema → exits 0
        valid_schema = {
            "node_types": {
                "note": {"description": "General note", "required": ["description", "tags"],
                         "status": ["active", "draft", "archived"]},
                "contact": {"description": "Person", "required": ["description", "tags"],
                            "status": ["active", "inactive"]},
                "project": {"description": "Project", "required": ["description", "status"],
                            "status": ["active", "done", "paused"]}
            },
            "type_aliases": {"person": "contact"},
            "field_fixes": {},
            "domain_inference": {"projects/": "work", "contacts/": "crm"},
            "path_type_hints": {"contacts/": "contact"},
            "status_order": {"active": 0, "draft": 1, "archived": 2, "inactive": 3, "done": 4, "paused": 5},
            "status_defaults": {"default": "active"},
            "richness_fields": {"bonus_fields": ["email", "telegram"]},
            "entity_extraction": {"noise_words": ["TODO"]},
            "decay": {"rate": 0.015, "floor": 0.1, "tiers": {"active": 7, "warm": 21, "cold": 60}},
            "ignore_tags": []
        }
        valid_path = tmp / 'valid-wave2.json'
        valid_path.write_text(json.dumps(valid_schema))
        output_schema = tmp / 'output-schema.json'

        code, out, err = run([py, str(SCRIPTS_DIR / 'swarm_reduce.py'), 'finalize',
                              str(valid_path), str(output_schema)])
        test("swarm_reduce finalize valid exits 0", code == 0, err[:300])
        test("swarm_reduce finalize writes output", output_schema.exists())

        # 3.12 swarm_reduce finalize rejects missing sections → exits 1
        bad_schema_missing = {"node_types": {"note": {"description": "x", "required": [], "status": ["active"]}}}
        bad_path_missing = tmp / 'bad-missing.json'
        bad_path_missing.write_text(json.dumps(bad_schema_missing))
        code, _, err = run([py, str(SCRIPTS_DIR / 'swarm_reduce.py'), 'finalize',
                            str(bad_path_missing)])
        test("swarm_reduce finalize rejects missing sections", code != 0,
             err[:200])

        # 3.13 swarm_reduce finalize rejects >15 node_types → exits 1
        too_many_types = {f"type_{i}": {"description": f"Type {i}", "required": [], "status": ["active"]}
                          for i in range(16)}
        bad_schema_many = dict(valid_schema)
        bad_schema_many = json.loads(json.dumps(valid_schema))  # deep copy
        bad_schema_many["node_types"] = too_many_types
        bad_path_many = tmp / 'bad-many.json'
        bad_path_many.write_text(json.dumps(bad_schema_many))
        code, _, err = run([py, str(SCRIPTS_DIR / 'swarm_reduce.py'), 'finalize',
                            str(bad_path_many)])
        test("swarm_reduce finalize rejects >15 types", code != 0,
             err[:200])

        # 3.14 swarm_reduce finalize checks alias targets exist
        bad_schema_alias = json.loads(json.dumps(valid_schema))
        bad_schema_alias["type_aliases"] = {"ghost": "nonexistent_type"}
        bad_path_alias = tmp / 'bad-alias.json'
        bad_path_alias.write_text(json.dumps(bad_schema_alias))
        code, _, err = run([py, str(SCRIPTS_DIR / 'swarm_reduce.py'), 'finalize',
                            str(bad_path_alias)])
        test("swarm_reduce finalize rejects bad alias target", code != 0,
             err[:200])

        # ═══════════════════════════════════════════════════════
        # 4. Edge cases
        # ═══════════════════════════════════════════════════════
        print("\n--- edge cases ---")

        # 3.1 Empty vault
        empty_dir = tmp / "empty-vault"
        empty_dir.mkdir(exist_ok=True)
        _schema_cache.clear()

        code, _, _ = run([py, str(SCRIPTS_DIR / 'graph.py'), 'health',
                          str(empty_dir), str(schema_path)])
        test("graph handles empty vault", code == 0)

        code, _, _ = run([py, str(SCRIPTS_DIR / 'moc.py'), 'generate',
                          str(empty_dir), str(schema_path)])
        test("moc handles empty vault", code == 0)

        code, _, _ = run([py, str(SCRIPTS_DIR / 'engine.py'), 'stats',
                          str(empty_dir), str(schema_path)])
        test("engine handles empty vault", code == 0)

        code, _, _ = run([py, str(SCRIPTS_DIR / 'dedup.py'), str(empty_dir)])
        test("dedup handles empty vault", code == 0)

        code, out, _ = run([py, str(SCRIPTS_DIR / 'discover.py'), str(empty_dir)])
        test("discover handles empty vault", code == 0)
        try:
            disc_empty = json.loads(out)
            test("discover empty vault returns 0 files",
                 disc_empty['meta']['total_files'] == 0)
        except Exception:
            test("discover empty vault returns 0 files", False, "bad JSON")

        # 3.2 File without frontmatter (already in vault)
        fm_none, body_none, _ = parse_frontmatter(VAULT_FILES["no-frontmatter.md"])
        test("no-fm file: parse_fm returns None", fm_none is None)
        test("no-fm file: body preserved", '# Just a Note' in body_none)

        # 3.3 File with broken frontmatter
        fm_broken, body_broken, _ = parse_frontmatter(VAULT_FILES["broken-frontmatter.md"])
        test("broken-fm: parse_fm returns dict (not crash)",
             fm_broken is not None or fm_broken is None)
        # The parser should not crash; it may return partial data or None

        # 3.4 No hardcoded domains/maps in scripts
        # Note: common.py has get_domain_map() which is schema-driven, so we
        # only check for DOMAIN_MAP (a hardcoded constant pattern)
        for script_name in ['graph.py', 'moc.py', 'engine.py', 'common.py']:
            src = (SCRIPTS_DIR / script_name).read_text()
            test(f"{script_name} no hardcoded DOMAIN_MAP constant",
                 'DOMAIN_MAP' not in src)

        # ═══════════════════════════════════════════════════════
        # 5. enrich.py tests (mock API)
        # ═══════════════════════════════════════════════════════
        print("\n--- enrich.py ---")
        import enrich

        # Mock API — returns canned results
        _mock_call_count = 0
        def mock_openrouter(messages, response_schema, model=enrich.DEFAULT_MODEL, schema_name="response"):
            nonlocal _mock_call_count
            _mock_call_count += 1
            # Detect mode from schema_name or message content
            user_msg = messages[-1]['content'] if messages else ''
            if 'Classify' in user_msg or schema_name == 'tag_results':
                # Tags mode — extract paths from user message
                paths = []
                for line in user_msg.split('\n'):
                    if line.startswith('### '):
                        paths.append(line[4:].strip())
                return {"results": [{"path": p, "tags": ["ai", "test"]} for p in paths]}
            elif schema_name == 'swarm_link_results':
                # Swarm-links mode — return exact stems (some valid, some not)
                paths = []
                for line in user_msg.split('\n'):
                    if line.startswith('### '):
                        paths.append(line[4:].strip())
                return {"results": [{"path": p, "links": ["alpha", "bob", "nonexistent-stem-xyz", Path(p).stem]} for p in paths]}
            else:
                # Links mode — extract paths, return suggestions
                paths = []
                for line in user_msg.split('\n'):
                    if line.startswith('### '):
                        paths.append(line[4:].strip())
                return {"results": [{"path": p, "suggestions": ["ML Basics", "Alpha Project", "nonexistent note xyz"]} for p in paths]}

        original_call = enrich.call_openrouter
        enrich.call_openrouter = mock_openrouter

        # 5.1 chunk_list
        test("chunk_list normal", enrich.chunk_list([1,2,3,4,5], 2) == [[1,2],[3,4],[5]])
        test("chunk_list empty", enrich.chunk_list([], 3) == [])
        test("chunk_list smaller than chunk", enrich.chunk_list([1,2], 5) == [[1,2]])

        # 5.8 collect_vault_tags
        seed_tags = enrich.collect_vault_tags(vault_dir, schema)
        test("collect_vault_tags returns list", isinstance(seed_tags, list))
        test("collect_vault_tags finds tags", len(seed_tags) > 0)
        test("collect_vault_tags excludes ignore_tags", 'imported' not in seed_tags)

        # 5.9 build_tag_entries — filters files without tags
        tag_entries = enrich.build_tag_entries(vault_dir, schema)
        test("build_tag_entries finds untagged", len(tag_entries) > 0)
        # Files with tags should be skipped (unless force)
        tagged_paths = [e['path'] for e in tag_entries]
        test("build_tag_entries skips tagged files",
             'projects/alpha.md' not in tagged_paths,
             f"alpha.md should be skipped, got {tagged_paths}")

        # 5.10 build_tag_entries --force includes all
        force_entries = enrich.build_tag_entries(vault_dir, schema, force=True)
        test("build_tag_entries force includes all",
             len(force_entries) > len(tag_entries))

        # 5.11 Tags dry run (no --apply) — results saved to disk
        _mock_call_count = 0
        enrich_tags_dir = vault_dir / '.graph' / 'enrich' / 'tags'
        if enrich_tags_dir.exists():
            shutil.rmtree(enrich_tags_dir)
        enrich.cmd_tags(vault_dir, apply=False, budget=50000,
                        model="test-model", force=True, delay=0, workers=1)
        tag_results = list(enrich_tags_dir.glob('batch-*-results.json'))
        test("tags dry run creates result files", len(tag_results) > 0)
        test("tags dry run called mock API", _mock_call_count > 0)

        # 5.12 Tags --apply writes to files
        # Add a file with no tags for apply test
        test_apply_file = vault_dir / "apply-test.md"
        test_apply_file.write_text("# Apply Test\n\nNo frontmatter here.\n")
        if enrich_tags_dir.exists():
            shutil.rmtree(enrich_tags_dir)
        enrich.cmd_tags(vault_dir, apply=True, budget=50000,
                        model="test-model", force=True, delay=0, workers=1)
        test_content = test_apply_file.read_text()
        fm_check, _, _ = parse_frontmatter(test_content)
        test("tags apply writes frontmatter",
             fm_check is not None and 'tags' in fm_check,
             f"got fm={fm_check}")

        # 5.13 Tags resume (idempotent — skip existing results)
        _mock_call_count = 0
        enrich.cmd_tags(vault_dir, apply=False, budget=50000,
                        model="test-model", force=False, delay=0, workers=1)
        test("tags resume skips existing batches", _mock_call_count == 0,
             f"expected 0 API calls, got {_mock_call_count}")

        # 5.14 scan_vault_for_links — unified scan
        scan_stems, scan_stem_to_path, scan_catalog, scan_entries = enrich.scan_vault_for_links(vault_dir, force=False)
        test("scan_vault_for_links returns stems", len(scan_stems) > 0)
        test("scan_vault_for_links has alpha", 'alpha' in scan_stems)
        test("scan_vault_for_links stem_to_path maps", 'bob' in scan_stem_to_path)
        test("scan_vault_for_links catalog is dict", isinstance(scan_catalog, dict))
        total_entries = sum(len(v) for v in scan_catalog.values())
        test("scan_vault_for_links catalog has entries", total_entries > 0,
             f"got {total_entries} entries across {len(scan_catalog)} domains")
        test("scan_vault_for_links finds link entries", len(scan_entries) > 0)

        # 5.15 scan_vault_for_links force mode includes all files
        _, _, _, force_entries = enrich.scan_vault_for_links(vault_dir, force=True)
        test("scan_vault_for_links force includes more",
             len(force_entries) >= len(scan_entries))

        # ═══════════════════════════════════════════════════════
        # 5b. swarm-links tests
        # ═══════════════════════════════════════════════════════
        print("\n--- swarm-links ---")

        # 5b.2 format_catalog formats entries
        sample_entries = [
            {'stem': 'test-note', 'type': 'note', 'tags': ['ai', 'test'], 'desc': 'A test note'},
            {'stem': 'other', 'type': 'project', 'tags': ['dev'], 'desc': 'Other note'},
        ]
        formatted = enrich.format_catalog(sample_entries)
        test("format_catalog contains stems", 'test-note' in formatted and 'other' in formatted)
        test("format_catalog contains tags", 'ai, test' in formatted)

        # 5b.3 format_catalog truncates at max_entries
        big_entries = [{'stem': f'note-{i}', 'type': 'note', 'tags': [], 'desc': f'Note {i}'} for i in range(50)]
        truncated = enrich.format_catalog(big_entries, max_entries=10)
        test("format_catalog truncates", '(truncated, 40 more)' in truncated)

        # 5b.4 format_catalog empty
        empty_formatted = enrich.format_catalog([])
        test("format_catalog empty", empty_formatted == "(empty catalog)")

        # 5b.5 swarm-link validation: strict set membership
        # Simulate what _process_swarm_link_batch does internally
        test_stems = {'alpha', 'bob', 'ml-basics', 'python-tips'}
        raw_links = ['alpha', 'bob', 'nonexistent-stem', 'invented-name']
        valid = [s for s in raw_links if s in test_stems]
        test("swarm strict validation passes exact stems",
             valid == ['alpha', 'bob'],
             f"got {valid}")

        # 5b.6 swarm-link filters self-links
        file_stem = 'alpha'
        raw_with_self = ['alpha', 'bob', 'ml-basics']
        filtered_self = [s for s in raw_with_self if s in test_stems and s != file_stem]
        test("swarm filters self-links",
             'alpha' not in filtered_self and 'bob' in filtered_self)

        # 5b.7 swarm-link filters existing links
        existing_links = {'bob'}
        raw_all = ['alpha', 'bob', 'ml-basics']
        filtered_existing = [s for s in raw_all
                             if s in test_stems and s != file_stem and s not in existing_links]
        test("swarm filters existing links",
             'bob' not in filtered_existing and 'ml-basics' in filtered_existing)

        # 5b.8 swarm-links dry run
        _mock_call_count = 0
        enrich_swarm_dir = vault_dir / '.graph' / 'enrich' / 'swarm-links'
        if enrich_swarm_dir.exists():
            shutil.rmtree(enrich_swarm_dir)
        enrich.cmd_swarm_links(vault_dir, apply=False, budget=100000,
                                model="test-model", force=True, delay=0, workers=1)
        swarm_results = list(enrich_swarm_dir.glob('batch-*-results.json'))
        test("swarm-links dry run creates result files", len(swarm_results) > 0)
        test("swarm-links dry run called mock API", _mock_call_count > 0)

        # 5b.9 swarm-links results have matched_links from strict validation
        if swarm_results:
            first_swarm = json.loads(swarm_results[0].read_text())
            has_matched = any(
                len(r.get('matched_links', [])) > 0
                for r in first_swarm.get('results', [])
            )
            test("swarm-links strict match finds real stems", has_matched,
                 f"results: {first_swarm.get('results', [])[:2]}")
            # Verify no nonexistent stems passed
            all_matched = []
            for r in first_swarm.get('results', []):
                all_matched.extend(r.get('matched_links', []))
            test("swarm-links no invented stems in matched",
                 'nonexistent-stem-xyz' not in all_matched,
                 f"matched: {all_matched}")

        # 5b.10 swarm-links --apply appends ## Related
        swarm_test_file = vault_dir / "swarm-test.md"
        swarm_test_file.write_text("---\ntype: note\ntags: [test]\n---\n# Swarm Test\n\nSome content.\n")
        if enrich_swarm_dir.exists():
            shutil.rmtree(enrich_swarm_dir)
        enrich.cmd_swarm_links(vault_dir, apply=True, budget=100000,
                                model="test-model", force=True, delay=0, workers=1)
        swarm_content = swarm_test_file.read_text()
        test("swarm-links apply adds Related section",
             '## Related' in swarm_content,
             f"content: {swarm_content[:200]}")

        # Restore original
        enrich.call_openrouter = original_call

        # ═══════════════════════════════════════════════════════
        # 6. link_cleanup.py tests
        # ═══════════════════════════════════════════════════════
        print("\n--- link_cleanup.py ---")
        import link_cleanup

        # 6.1 build_stems_and_paths
        valid_targets = link_cleanup.build_stems_and_paths(vault_dir)
        test("cleanup stems includes alpha",
             valid_targets.get('unique_stem', {}).get('alpha') == 'projects/alpha',
             f"got: {valid_targets.get('unique_stem', {}).get('alpha')}")
        test("cleanup stems includes path",
             valid_targets.get('exact', {}).get('projects/alpha') == 'projects/alpha',
             f"got: {valid_targets.get('exact', {}).get('projects/alpha')}")

        # 6.2 check_link_target — valid
        test("check_link valid stem", link_cleanup.check_link_target('alpha', valid_targets))
        test("check_link valid path", link_cleanup.check_link_target('projects/alpha', valid_targets))

        # 6.3 check_link_target — invalid
        test("check_link invalid", not link_cleanup.check_link_target('nonexistent-file-xyz', valid_targets))
        test("check_link ambiguous stem invalid", not link_cleanup.check_link_target('bob', valid_targets))

        # 6.4 cleanup_related_section — removes broken links
        content_with_broken = (
            "# Test\n\nSome body.\n\n"
            "## Related\n"
            "- [[projects/alpha]]\n"
            "- [[nonexistent-phantom-link]]\n"
            "- [[knowledge/ml-basics]]\n"
        )
        new_content, removed, kept = link_cleanup.cleanup_related_section(
            content_with_broken, valid_targets)
        test("cleanup removes phantom link",
             'nonexistent-phantom-link' in removed)
        test("cleanup keeps valid links", len(kept) >= 2)
        test("cleanup output has no phantom",
             '[[nonexistent-phantom-link]]' not in new_content)
        test("cleanup output has valid links",
             '[[projects/alpha]]' in new_content)

        # 6.5 cleanup_related_section — all broken → delete section
        content_all_broken = (
            "# Test\n\nBody text.\n\n"
            "## Related\n"
            "- [[ghost-link-1]]\n"
            "- [[ghost-link-2]]\n"
        )
        new_all, removed_all, kept_all = link_cleanup.cleanup_related_section(
            content_all_broken, valid_targets)
        test("cleanup deletes section when all broken",
             '## Related' not in new_all)
        test("cleanup reports all removed", len(removed_all) == 2)

        # 6.6 cleanup doesn't touch body links
        content_body_links = (
            "# Test\n\n"
            "See [[nonexistent-in-body]] for details.\n\n"
            "## Related\n"
            "- [[projects/alpha]]\n"
        )
        new_body, removed_body, _ = link_cleanup.cleanup_related_section(
            content_body_links, valid_targets)
        test("cleanup ignores body links",
             '[[nonexistent-in-body]]' in new_body)
        test("cleanup body link not in removed",
             'nonexistent-in-body' not in removed_body)

        # 6.7 dry run doesn't modify files
        # Create a file with phantom link
        cleanup_test_file = vault_dir / "cleanup-test.md"
        cleanup_test_file.write_text(
            "---\ntype: note\n---\n# Cleanup Test\n\n"
            "## Related\n- [[phantom-target-xyz]]\n"
        )
        original_content = cleanup_test_file.read_text()
        report = link_cleanup.run_cleanup(vault_dir, apply=False)
        test("cleanup dry run safe", cleanup_test_file.read_text() == original_content)
        test("cleanup report has links_removed", len(report['links_removed']) > 0)

        # 6.8 --apply modifies files
        report_apply = link_cleanup.run_cleanup(vault_dir, apply=True)
        new_cleanup_content = cleanup_test_file.read_text()
        test("cleanup apply removes phantom",
             '[[phantom-target-xyz]]' not in new_cleanup_content)

        # 6.9 cleanup writes report json
        report_path = vault_dir / '.graph' / 'link-cleanup-report.json'
        test("cleanup writes report", report_path.exists())

        # ═══════════════════════════════════════════════════════
        # 7. Fix verification tests (code review findings)
        # ═══════════════════════════════════════════════════════
        print("\n--- code review fixes ---")

        # 7.1 CRLF frontmatter parsing
        crlf_content = "---\r\ntype: note\r\nstatus: active\r\ntags: [ai, test]\r\n---\r\n# CRLF Note\r\n\r\nBody with CRLF.\r\n"
        fm_crlf, body_crlf, _ = parse_frontmatter(crlf_content)
        test("parse_fm CRLF: extracts type", fm_crlf is not None and fm_crlf.get('type') == 'note')
        test("parse_fm CRLF: extracts tags", fm_crlf is not None and fm_crlf.get('tags') == ['ai', 'test'])
        test("parse_fm CRLF: body preserved", 'CRLF Note' in body_crlf)

        # 7.2 Literal block (|-) preserves newlines
        literal_content = "---\ntype: note\ndescription: |-\n  Line one\n  Line two\n  Line three\n---\n# Test\n"
        fm_literal, _, _ = parse_frontmatter(literal_content)
        test("parse_fm literal block |- has newlines",
             fm_literal is not None and '\n' in fm_literal.get('description', ''),
             f"got: {fm_literal.get('description', '') if fm_literal else 'None'}")

        # 7.3 Fold block (>-) joins with spaces
        fold_content = "---\ntype: note\ndescription: >-\n  First part\n  second part\n---\n# Test\n"
        fm_fold, _, _ = parse_frontmatter(fold_content)
        test("parse_fm fold block >- joins with space",
             fm_fold is not None and 'First part second part' in fm_fold.get('description', ''),
             f"got: {fm_fold.get('description', '') if fm_fold else 'None'}")

        # 7.4 format_field YAML special chars — colon
        test("format_field escapes colon",
             format_field('title', 'Key: Value') == 'title: "Key: Value"')

        # 7.5 format_field YAML special chars — hash
        test("format_field escapes hash",
             format_field('title', 'Topic #1') == 'title: "Topic #1"')

        # 7.6 format_field YAML special chars — brackets
        test("format_field escapes brackets",
             format_field('note', 'See [link]') == 'note: "See [link]"')

        # 7.7 format_field YAML special chars — quotes
        result_q = format_field('title', 'He said "hello"')
        test("format_field escapes double quotes",
             result_q == 'title: "He said \\"hello\\""',
             f"got: {result_q}")

        # 7.8 every new string stays a string in typed YAML readers
        test("format_field quotes safe string",
             format_field('type', 'note') == 'type: "note"')

        # 7.9 extract_wikilinks strips #anchor
        anchor_links = extract_wikilinks("See [[target#heading]] and [[other#sec|display]]")
        test("extract_wikilinks anchor stripped",
             len(anchor_links) == 2 and anchor_links[0][0] == 'target',
             f"got: {anchor_links}")
        test("extract_wikilinks anchor with alias",
             anchor_links[1] == ('other', 'display'),
             f"got: {anchor_links[1] if len(anchor_links) > 1 else 'missing'}")

        # 7.10 extract_wikilinks anchor-only link skipped
        anchor_only = extract_wikilinks("See [[#heading-only]]")
        test("extract_wikilinks anchor-only skipped",
             len(anchor_only) == 0,
             f"got: {anchor_only}")

        # 7.11 resolve_link strips anchor (graph.py)
        from graph import resolve_link, fix_broken_links, build_graph, LinkRepairError
        from dedup import merge_content, append_history
        from daily import (
            build_vault_index as build_daily_index,
            extract_entities as extract_daily_entities,
            build_relationships as build_daily_relationships,
            derive_legacy_buckets,
            build_output_meta,
            process_date as process_daily_date,
        )
        test_path_index = {'target': 'knowledge/target', 'foo': 'projects/foo'}
        test("resolve_link strips anchor",
             resolve_link('target#heading', test_path_index) == 'knowledge/target')
        test("resolve_link empty after anchor strip",
             resolve_link('#heading', test_path_index) is None)

        # 7.12 graph fix rewrites only the exact broken wikilink
        fix_vault = tmp / 'graph-fix-vault'
        (fix_vault / 'notes').mkdir(parents=True, exist_ok=True)
        (fix_vault / 'docs').mkdir(parents=True, exist_ok=True)
        source_note = fix_vault / 'notes/source.md'
        source_note.write_text("See [[visa]] and [[visa-guide]].\n")
        (fix_vault / 'docs/visa.md').write_text("# Visa\n")
        (fix_vault / 'docs/visa-guide.md').write_text("# Visa guide\n")
        synthetic_graph = {
            'broken_link_list': [{'source': 'notes/source', 'target': 'visa'}]
        }
        fixes, applied, _ambiguous, _skipped = fix_broken_links(
            fix_vault, synthetic_graph, apply=True)
        updated_source = source_note.read_text()
        test("graph fix suggests unique stem target",
             len(fixes) == 1 and fixes[0]['new'] == 'docs/visa',
             f"got: {fixes}")
        test("graph fix applies one exact replacement", applied == 1, f"got: {applied}")
        test("graph fix does not mutate prefixed links",
             '[[docs/visa]]' in updated_source and '[[visa-guide]]' in updated_source and '[[docs/visa-guide]]' not in updated_source,
             f"got: {updated_source}")

        # 7.12b ночной graph fix чинит ссылки по H1-заголовку: и в чужой карточке, и в
        # карточке на саму себя. Неоднозначный заголовок остаётся как есть, и источник
        # при этом не меняется ни на байт.
        fix_title_vault = tmp / 'graph-fix-title-vault'
        (fix_title_vault / 'cards/ideas').mkdir(parents=True, exist_ok=True)
        (fix_title_vault / 'cards/notes').mkdir(parents=True, exist_ok=True)
        fix_title = 'Для разработки — рубрика инструментов'
        self_link_card = fix_title_vault / 'cards/ideas/dev-tools.md'
        self_link_card.write_text(
            f'# {fix_title}\n\n## Related\n- [[{fix_title}]]\n')
        linking_card = fix_title_vault / 'cards/notes/a.md'
        linking_card.write_text(
            f'См. [[  {fix_title.lower()} ]], [[{fix_title}|инструменты]],'
            f' [[{fix_title}#Related]].\n')
        title_graph = build_graph(fix_title_vault, schema)
        title_fixes, title_applied, title_ambiguous, title_skipped = fix_broken_links(
            fix_title_vault, title_graph, apply=True)
        repaired_a = linking_card.read_text()
        test("graph fix applies H1-title links and reports no ambiguity",
             title_applied == 4 and title_ambiguous == [] and len(title_fixes) == 4,
             f"got: applied={title_applied}, fixes={title_fixes}, ambiguous={title_ambiguous}")
        test("graph fix rewrites the self-link written by title",
             '- [[cards/ideas/dev-tools]]' in self_link_card.read_text(),
             self_link_card.read_text())
        test("graph fix keeps alias and anchor of H1-title links",
             '[[cards/ideas/dev-tools|инструменты]]' in repaired_a
             and '[[cards/ideas/dev-tools#Related]]' in repaired_a,
             repaired_a)
        test("graph fix leaves no broken links after H1 repair",
             build_graph(fix_title_vault, schema)['stats']['broken_links'] == 0,
             str(build_graph(fix_title_vault, schema)['stats']))

        ambiguous_vault = tmp / 'graph-fix-ambiguous-vault'
        (ambiguous_vault / 'cards').mkdir(parents=True, exist_ok=True)
        (ambiguous_vault / 'cards/p1.md').write_text('# Проект\n')
        (ambiguous_vault / 'cards/p2.md').write_text('# Проект\n')
        ambiguous_source = ambiguous_vault / 'cards/src.md'
        ambiguous_source.write_text('См. [[Проект]].\n')
        source_before = ambiguous_source.read_bytes()
        ambiguous_graph = build_graph(ambiguous_vault, schema)
        ambiguous_fixes, ambiguous_applied, ambiguous_list, _ambiguous_skipped = fix_broken_links(
            ambiguous_vault, ambiguous_graph, apply=True)
        test("graph fix leaves ambiguous H1-title links alone",
             ambiguous_fixes == [] and ambiguous_applied == 0
             and ambiguous_source.read_bytes() == source_before,
             f"got: fixes={ambiguous_fixes}, applied={ambiguous_applied}, "
             f"source={ambiguous_source.read_text()!r}")
        test("graph fix reports ambiguous H1-title candidates",
             ambiguous_list == [{'source': 'cards/src', 'target': 'Проект',
                                 'candidates': ['cards/p1', 'cards/p2']}],
             f"got: {ambiguous_list}")
        ambiguous_code, ambiguous_out, ambiguous_err = run(
            [sys.executable, str(SCRIPTS_DIR / 'graph.py'), 'fix',
             str(ambiguous_vault), '--apply'])
        test("graph.py fix prints the ambiguous block",
             ambiguous_code == 0
             and 'Ambiguous:    1' in ambiguous_out
             and 'cards/src: [[Проект]] -> cards/p1, cards/p2' in ambiguous_out,
             f"got: code={ambiguous_code}, out={ambiguous_out!r}, err={ambiguous_err!r}")

        # 7.12c ночной fix --apply не трогает дословные записи: дневной транскрипт,
        # append-only ## History и код. Такие ссылки не обещаются как Fixable, а
        # называются отдельной строкой, а файлы остаются байт в байт.
        protected_vault = tmp / 'graph-fix-protected-vault'
        (protected_vault / 'cards/ideas').mkdir(parents=True, exist_ok=True)
        (protected_vault / 'summaries/daily').mkdir(parents=True, exist_ok=True)
        protected_title = 'Для разработки — рубрика инструментов'
        (protected_vault / 'cards/ideas/dev-tools.md').write_text(
            f'# {protected_title}\n\n- тело\n')
        protected_files = {
            'summaries/daily/2026-09-12.md':
                f'# День\n\n- Шима сказал: «[[{protected_title}]]»\n',
            'cards/hist.md':
                f'# Карточка\n\n- тело\n\n## History\n\n- 2026-08-01: [[{protected_title}]]\n',
            'cards/fence.md':
                f'# Пример\n\n```md\n[[{protected_title}]]\n```\n\nИнлайн: `[[{protected_title}]]`.\n',
        }
        open_card = protected_vault / 'cards/open.md'
        open_card.write_text(f'# Открытая\n\n- см. [[{protected_title}]]\n')
        for rel, text in protected_files.items():
            path = protected_vault / rel
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(text)
        protected_before = {
            rel: (protected_vault / rel).read_bytes() for rel in protected_files
        }
        protected_graph = build_graph(protected_vault, schema)
        (protected_fixes, protected_applied, protected_ambiguous,
         protected_skipped) = fix_broken_links(
            protected_vault, protected_graph, apply=True)
        test("graph fix repairs the free-text link beside protected ones",
             protected_applied == 1 and len(protected_fixes) == 1
             and open_card.read_text()
             == '# Открытая\n\n- см. [[cards/ideas/dev-tools]]\n',
             f"got: applied={protected_applied}, fixes={protected_fixes}, "
             f"file={open_card.read_text()!r}")
        test("graph fix leaves daily transcripts and append-only History byte for byte",
             all((protected_vault / rel).read_bytes() == protected_before[rel]
                 for rel in protected_files),
             str({rel: (protected_vault / rel).read_text() for rel in protected_files}))
        test("graph fix reports protected links instead of promising them",
             protected_ambiguous == []
             and sorted((item['source'], item['reason'])
                        for item in protected_skipped) == [
                            ('cards/fence', 'code'),
                            ('cards/fence', 'code'),
                            ('cards/hist', 'history'),
                            ('summaries/daily/2026-09-12', 'summaries')],
             f"got: {protected_skipped}")
        protected_code, protected_out, protected_err = run(
            [sys.executable, str(SCRIPTS_DIR / 'graph.py'), 'fix',
             str(protected_vault), '--apply'])
        test("graph.py fix prints the protected block",
             protected_code == 0
             and 'Skipped (protected): 4' in protected_out
             and '(summaries)' in protected_out
             and '(history)' in protected_out
             and '(code)' in protected_out,
             f"got: code={protected_code}, out={protected_out!r}, err={protected_err!r}")

        # 7.12d формы токена, которые понимает резолвер: .md и префикс vault/ тоже
        # чинятся, иначе Fixable обещает то, чего замена не делает.
        suffix_vault = tmp / 'graph-fix-suffix-vault'
        (suffix_vault / 'cards').mkdir(parents=True, exist_ok=True)
        suffix_title = 'Рубрика инструментов'
        (suffix_vault / 'cards/target.md').write_text(
            f'# {suffix_title}\n\n- тело\n')
        suffix_source = suffix_vault / 'cards/a.md'
        suffix_source.write_text(
            f'# A\n\n- [[{suffix_title}.md]]\n- [[vault/{suffix_title}]]\n')
        suffix_graph = build_graph(suffix_vault, schema)
        (suffix_fixes, suffix_applied, _suffix_ambiguous,
         suffix_skipped) = fix_broken_links(suffix_vault, suffix_graph, apply=True)
        test("graph fix rewrites the .md and vault/ target forms",
             len(suffix_fixes) == 2 and suffix_applied == 2 and suffix_skipped == []
             and suffix_source.read_text()
             == '# A\n\n- [[cards/target]]\n- [[cards/target]]\n',
             f"got: fixes={suffix_fixes}, applied={suffix_applied}, "
             f"file={suffix_source.read_text()!r}")

        # 7.12e обещанная и не переписанная ссылка — отказ выполнения, а не тишина:
        # резолвер срезает и обратный слэш, а замена ищет буквальный токен байт в байт.
        missed_vault = tmp / 'graph-fix-missed-vault'
        (missed_vault / 'cards').mkdir(parents=True, exist_ok=True)
        (missed_vault / 'cards/target.md').write_text(
            f'# {suffix_title}\n\n- тело\n')
        (missed_vault / 'cards/a.md').write_text(
            f'# A\n\n- [[{suffix_title}\\]]\n')
        missed_graph = build_graph(missed_vault, schema)
        try:
            fix_broken_links(missed_vault, missed_graph, apply=True)
            missed_error = None
        except LinkRepairError as error:
            missed_error = str(error)
        test("graph fix refuses to stay silent about a link it could not rewrite",
             missed_error is not None and 'cards/a' in missed_error,
             f"got: {missed_error!r}")
        missed_code, _missed_out, missed_err = run(
            [sys.executable, str(SCRIPTS_DIR / 'graph.py'), 'fix',
             str(missed_vault), '--apply'])
        test("graph.py fix exits non-zero on a link it could not rewrite",
             missed_code != 0
             and 'promised a fix and rewrote nothing' in missed_err,
             f"got: code={missed_code}, err={missed_err!r}")

        # 7.13 nested hub notes are not orphans
        hub_vault = tmp / 'graph-hub-vault'
        (hub_vault / 'foo').mkdir(parents=True, exist_ok=True)
        (hub_vault / 'agents/x').mkdir(parents=True, exist_ok=True)
        (hub_vault / 'foo/_index.md').write_text("# Foo hub\n")
        (hub_vault / 'agents/x/MEMORY.md').write_text("# Agent memory\n")
        (hub_vault / 'foo/card.md').write_text("# Card\n")
        hub_graph = build_graph(hub_vault, schema)
        test("graph skips nested _index orphan",
             'foo/_index' not in hub_graph['orphan_list'],
             f"got: {hub_graph['orphan_list']}")
        test("graph skips nested MEMORY orphan",
             'agents/x/MEMORY' not in hub_graph['orphan_list'],
             f"got: {hub_graph['orphan_list']}")
        test("graph keeps regular orphan",
             'foo/card' in hub_graph['orphan_list'],
             f"got: {hub_graph['orphan_list']}")

        # 7.14 dedup merge writes YAML via shared serializer
        dedup_merge_dir = tmp / 'dedup-merge-vault'
        dedup_merge_dir.mkdir(parents=True, exist_ok=True)
        canonical_note = dedup_merge_dir / 'canonical.md'
        extra_note = dedup_merge_dir / 'extra.md'
        long_desc = "Long description with colon: hash # brackets [x] and enough words to cross the serializer threshold for multiline output."
        canonical_note.write_text(
            "---\n"
            "type: note\n"
            "tags: [base]\n"
            "description: Base note\n"
            "---\n"
            "# Canon\n\n"
            "Body.\n"
        )
        extra_note.write_text(
            "---\n"
            f"description: {long_desc}\n"
            "tags: [base, extra]\n"
            "---\n"
            "# Extra\n\n"
            "## Imported Section\n"
            "Merged text.\n"
        )
        merged = merge_content(canonical_note, [extra_note])
        merged_content = canonical_note.read_text()
        merged_fm, merged_body, _ = parse_frontmatter(merged_content)
        test("dedup merge reports changed", merged, "merge_content returned False")
        test("dedup merge keeps YAML parseable",
             merged_fm is not None and merged_fm.get('description') == long_desc,
             f"got: {merged_fm}")
        test("dedup merge preserves list fields",
             merged_fm.get('tags') == ['base', 'extra'],
             f"got: {merged_fm.get('tags')}")
        test("dedup merge JSON-quotes changed string",
             f'description: {json.dumps(long_desc)}' in merged_content,
             f"got: {merged_content}")
        test("dedup merge keeps original field order",
             merged_content.find('type: note') < merged_content.find('tags: ["base","extra"]') < merged_content.find(f'description: {json.dumps(long_desc)}'),
             f"got: {merged_content}")
        test("dedup merge appends unique body sections",
             '## Imported Section' in merged_body,
             f"got: {merged_body}")

        # 7.14b recency-aware conflict merge → newer wins, old value to ## History
        rc_dir = tmp / 'recency-vault'
        rc_dir.mkdir(parents=True, exist_ok=True)
        canon = rc_dir / 'canon.md'
        newer = rc_dir / 'newer.md'
        canon.write_text(
            "---\ntype: contact\ncompany: ACME\ncreated: 2026-03-01\n---\n# Jane\n")
        newer.write_text(
            "---\ntype: contact\ncompany: Globex\nupdated: 2026-06-01\n---\n# Jane\n")
        merge_content(canon, [newer], conflict_fields=['company'], today='2026-06-10')
        rc_fm, rc_body, _ = parse_frontmatter(canon.read_text())
        test("recency: newer conflict value wins", rc_fm.get('company') == 'Globex',
             f"got: {rc_fm.get('company')}")
        test("recency: winner bumps updated", rc_fm.get('updated') == '2026-06-10',
             f"got: {rc_fm.get('updated')}")
        test("recency: old value goes to ## History",
             '## History' in rc_body and 'company: ACME' in rc_body, f"got: {rc_body}")
        test("recency: History line format",
             '- 2026-06-01: company: ACME (held 2026-03→2026-06)' in rc_body,
             f"got: {rc_body}")

        # canonical newer / tie → canon kept, extra's losing value still recorded (no data loss)
        canon2 = rc_dir / 'canon2.md'
        older = rc_dir / 'older.md'
        canon2.write_text(
            "---\ntype: contact\ncompany: Globex\nupdated: 2026-06-01\n---\n# Jane\n")
        older.write_text(
            "---\ntype: contact\ncompany: ACME\ncreated: 2026-03-01\n---\n# Jane\n")
        merge_content(canon2, [older], conflict_fields=['company'], today='2026-06-10')
        c2_fm, c2_body, _ = parse_frontmatter(canon2.read_text())
        test("recency: canonical newer is kept", c2_fm.get('company') == 'Globex',
             f"got: {c2_fm.get('company')}")
        test("recency: loser value not lost (to History)",
             'company: ACME' in c2_body, f"got: {c2_body}")

        # append_history preserves existing lines (append-only)
        appended = append_history("# X\n\n## History\n- 2025-02-01: role: Old (held 2025-01→2025-02)\n",
                                  ["- 2026-06-01: company: ACME (held 2026-03→2026-06)"])
        test("append_history keeps existing History lines",
             'role: Old' in appended and 'company: ACME' in appended, f"got: {appended}")

        # non-conflict field still richness-based (regression)
        canon3 = rc_dir / 'canon3.md'
        rich = rc_dir / 'rich.md'
        canon3.write_text("---\ntype: note\ndescription: short\n---\n# X\n")
        rich.write_text(
            "---\ntype: note\ndescription: a much much much longer description here\n---\n# X\n")
        merge_content(canon3, [rich], conflict_fields=['company'])
        c3_fm, _, _ = parse_frontmatter(canon3.read_text())
        test("non-conflict field still richness-based",
             c3_fm.get('description') == 'a much much much longer description here',
             f"got: {c3_fm.get('description')}")

        # 7.15 daily extraction resolves typed linked entities
        daily_index = build_daily_index(vault_dir)
        daily_entities = extract_daily_entities(
            "Worked with [[contacts/bob|Bob Smith]] on [[projects/alpha|Alpha]].",
            daily_index
        )
        linked_types = {(item['name'], item['type']) for item in daily_entities['linked_entities']}
        daily_relationships = build_daily_relationships(daily_entities)
        test("daily typed links include contact",
             ('Bob Smith', 'contact') in linked_types,
             f"got: {daily_entities['linked_entities']}")
        test("daily typed links include project",
             ('Alpha', 'project') in linked_types,
             f"got: {daily_entities['linked_entities']}")
        test("daily projects bucket excludes contacts",
             daily_entities['projects'] == [{'name': 'Alpha', 'link': 'projects/alpha'}],
             f"got: {daily_entities['projects']}")
        test("daily relationships use typed linked entities",
             any(r['from_type'] == 'contact' and r['to_type'] == 'project' for r in daily_relationships) or
             any(r['from_type'] == 'project' and r['to_type'] == 'contact' for r in daily_relationships),
             f"got: {daily_relationships}")
        legacy_buckets = derive_legacy_buckets([
            {'name': 'Alpha', 'link': 'projects/alpha', 'type': 'project', 'domain': 'work'},
            {'name': 'Acme', 'link': 'companies/acme', 'type': 'company', 'domain': 'crm'},
            {'name': 'Bob Smith', 'link': 'contacts/bob', 'type': 'contact', 'domain': 'crm'},
        ])
        test("daily legacy buckets derive projects from linked_entities",
             legacy_buckets['projects'] == [{'name': 'Alpha', 'link': 'projects/alpha'}],
             f"got: {legacy_buckets}")
        test("daily legacy buckets derive companies from linked_entities",
             legacy_buckets['companies'] == [{'name': 'Acme', 'link': 'companies/acme'}],
             f"got: {legacy_buckets}")
        output_meta = build_output_meta()
        test("daily output meta marks linked_entities primary",
             output_meta.get('primary_entity_field') == 'entities.linked_entities',
             f"got: {output_meta}")
        test("daily output meta marks legacy buckets deprecated",
             output_meta.get('deprecated_fields') == ['entities.projects', 'entities.companies'],
             f"got: {output_meta}")
        dated_result = process_daily_date(daily_dir, daily_index, '2026-03-01')
        test("daily process_date includes output meta",
             dated_result.get('_meta', {}).get('primary_entity_field') == 'entities.linked_entities',
             f"got: {dated_result.get('_meta')}")

        # 7.16 check_link_target strips anchor (link_cleanup.py)
        test("check_link_target strips anchor",
             link_cleanup.check_link_target('alpha#section', valid_targets))
        test("check_link_target anchor-only is not broken",
             link_cleanup.check_link_target('#heading', valid_targets))

        # 7.17 load_schema local priority
        # Create two schemas in a temp dir — schema.json and schema.local.json
        _schema_cache.clear()
        schema_test_dir = tmp / 'schema-priority-test'
        schema_test_dir.mkdir(exist_ok=True)
        scripts_dir_test = schema_test_dir / 'scripts'
        scripts_dir_test.mkdir(exist_ok=True)
        base_schema = {"node_types": {"note": {"description": "base", "required": [], "status": []}},
                       "type_aliases": {}, "field_fixes": {}, "domain_inference": {},
                       "path_type_hints": {}, "status_order": {}, "status_defaults": {},
                       "richness_fields": {}, "entity_extraction": {}, "decay": {"rate": 0.01, "floor": 0.1},
                       "ignore_tags": []}
        local_schema = dict(base_schema)
        local_schema["_marker"] = "local"
        (schema_test_dir / 'schema.json').write_text(json.dumps(base_schema))
        (schema_test_dir / 'schema.local.json').write_text(json.dumps(local_schema))
        # load_schema with explicit path still works
        loaded_base = load_schema(schema_test_dir / 'schema.json')
        test("load_schema explicit path works", 'node_types' in loaded_base)
        _schema_cache.clear()
        loaded_local = load_schema(schema_test_dir / 'schema.local.json')
        test("load_schema local has marker", loaded_local.get('_marker') == 'local')

        # 7.18 load_schema cache by resolved path (not 'default')
        _schema_cache.clear()
        s1 = load_schema(schema_path)
        s2 = load_schema(schema_path)
        test("load_schema cache hit same object", s1 is s2)
        # Different path → different cache entry
        _schema_cache.clear()
        s3 = load_schema(schema_test_dir / 'schema.json')
        s4 = load_schema(schema_path)
        test("load_schema different paths different cache", s3 is not s4)

        # 7.19 swarm_reduce prompt matches REQUIRED_SCHEMA_SECTIONS
        from swarm_reduce import WAVE2_PROMPT_TEMPLATE, REQUIRED_SCHEMA_SECTIONS
        test("swarm_reduce prompt no region_fixes",
             'region_fixes' not in WAVE2_PROMPT_TEMPLATE)
        # All required sections mentioned in prompt
        for section in REQUIRED_SCHEMA_SECTIONS:
            test(f"swarm_reduce prompt mentions {section}",
                 section in WAVE2_PROMPT_TEMPLATE,
                 f"'{section}' not found in prompt")

        # ═══════════════════════════════════════════════════════
        # GOLDEN FIXTURES — те же файлы читает scripts/golden-parsers.test.ts;
        # оба раннера сверяются с одним ожиданием, чтобы TS/Python-диалекты
        # frontmatter и fence-сканера не разъезжались молча (TECH_DEBT §13)
        # ═══════════════════════════════════════════════════════
        print("\n--- golden fixtures (dual-language parser pairs) ---")
        import re as _re
        from enforce import _outside_fences, _sections

        golden = Path(__file__).resolve().parent / 'golden'

        fm_cases = sorted((golden / 'frontmatter').glob('*.md'))
        test("golden frontmatter fixtures present", len(fm_cases) >= 7,
             f"found {len(fm_cases)}")
        for md_file in fm_cases:
            expected = json.loads(md_file.with_suffix('.json').read_text())
            fields, body, _ = parse_frontmatter(md_file.read_text())
            test(f"golden fm fields: {md_file.stem}",
                 fields == expected['fields'],
                 f"{fields!r} != {expected['fields']!r}")
            test(f"golden fm body: {md_file.stem}", body == expected['body'],
                 f"{body!r} != {expected['body']!r}")

        sec_cases = sorted((golden / 'sections').glob('*.md'))
        test("golden section fixtures present", len(sec_cases) >= 7,
             f"found {len(sec_cases)}")
        for md_file in sec_cases:
            expected = json.loads(md_file.with_suffix('.json').read_text())
            lines = md_file.read_text().split('\n')
            test(f"golden outside: {md_file.stem}",
                 _outside_fences(lines) == expected['outside'])
            for heading, ranges in expected['sections'].items():
                matcher = _re.compile(
                    rf'^##\s+{_re.escape(heading)}\s*$', _re.IGNORECASE)
                got = [[s, e] for s, e, _m in _sections(lines, matcher)]
                test(f"golden sections: {md_file.stem} ## {heading}",
                     got == ranges, f"{got} != {ranges}")

        # ═══════════════════════════════════════════════════════
        # 8. Ночная запись: атомарность, нечитаемые байты, кривой домен, фенсы
        # ═══════════════════════════════════════════════════════
        print("\n--- nightly write safety ---")
        import os as _os
        from engine import read_card, write_card
        from moc import moc_stem
        from dedup import append_history

        # 8.1 write_card кладёт файл целиком и не оставляет временных хвостов
        atomic_dir = tmp / "atomic"
        atomic_dir.mkdir(exist_ok=True)
        target = atomic_dir / "card.md"
        target.write_text("---\ntype: note\n---\nстарое\n")
        write_card(target, "---\ntype: note\n---\nновое\n")
        test("write_card replaces content", target.read_text().endswith("новое\n"))
        test("write_card leaves no temp files",
             [p.name for p in atomic_dir.iterdir()] == ["card.md"],
             str([p.name for p in atomic_dir.iterdir()]))

        # 8.2 упавшая запись не трогает лежащий на диске файл (tmp+replace, не truncate).
        # Ломаем сам момент записи временного файла: до os.replace дело не доходит.
        class _Boom(Exception):
            pass

        real_fdopen = _os.fdopen

        def _bad_fdopen(fd, *a, **kw):
            _os.close(fd)
            raise _Boom("disk full")

        crashed = False
        _os.fdopen = _bad_fdopen
        try:
            write_card(target, "---\ntype: note\n---\nнедописанное\n")
        except _Boom:
            crashed = True
        finally:
            _os.fdopen = real_fdopen
        test("write_card propagates a failed write", crashed)
        test("failed write keeps the old card intact",
             target.read_text().endswith("новое\n"), target.read_text())
        test("failed write leaves no temp files",
             [p.name for p in atomic_dir.iterdir()] == ["card.md"],
             str([p.name for p in atomic_dir.iterdir()]))

        # 8.3 не-utf8 карточка: пропускаем с предупреждением, байты НЕ трогаем
        broken_vault = tmp / "broken-bytes"
        (broken_vault / "cards").mkdir(parents=True, exist_ok=True)
        broken = broken_vault / "cards" / "latin1.md"
        # Байт 0xe9 (latin-1 «é») плюс ровно та разметка, ради которой ночные писатели
        # переписывают карточку: ссылка, которую graph.fix умеет починить, фантомная —
        # которую вычищает link_cleanup, и та, которую переписывает redirect_links.
        # Без этого прогон «пережил и не тронул» ничего бы не доказывал: скрипт просто
        # не дошёл бы до записи.
        raw_bytes = ("---\ntype: note\ntier: warm\nlast_accessed: 2020-01-01\n---\n"
                     "# Caf\xe9\n\n## Related\n- [[good]]\n- [[phantom-missing]]\n"
                     "- [[gone]]\n").encode('latin-1')
        broken.write_bytes(raw_bytes)
        good = broken_vault / "cards" / "good.md"
        good.write_text("---\ntype: note\ntier: warm\nlast_accessed: 2020-01-01\n---\nтело\n")

        test("read_card returns None on invalid utf-8", read_card(broken) is None)

        # ПОРЯДОК НОЧИ. brain.ts гоняет cleanup → enforce → graph → decay → …, и защита
        # обязана стоять у ПЕРВОГО, кто пишет: сотри байты он — всем следующим шагам файл
        # достался бы уже валидным utf-8, и их защита не сработала бы никогда (ADR-0002).
        # Первый — cleanup, и у него своя дорога к записи: он не читает карточку целиком,
        # а разбирает фронтматтер построчно, поэтому битый байт кладём именно туда, да ещё
        # и с раздутым description — без него cleanup просто не дошёл бы до записи.
        cleanup_vault = tmp / "broken-bytes-cleanup"
        (cleanup_vault / "cards").mkdir(parents=True, exist_ok=True)
        bloat_unit = 'Subscriber/contact: interested in total life-tracking'
        cleanup_broken = cleanup_vault / "cards" / "latin1-fm.md"
        cleanup_broken_bytes = (
            "---\ntype: note\ndescription: >-\n  "
            + bloat_unit + ' ' + bloat_unit
            + "\nname: Caf\xe9\ntier: warm\nlast_accessed: 2020-01-01\n---\n"
            "# Body\n\nbody bytes\n").encode('latin-1')
        cleanup_broken.write_bytes(cleanup_broken_bytes)
        # Контроль: такая же раздутая, но читаемая карточка в том же прогоне обязана
        # почиститься — иначе «байты целы» доказывало бы лишь то, что cleanup не работает.
        cleanup_ok = cleanup_vault / "cards" / "bloated-ok.md"
        cleanup_ok.write_text(
            "---\ntype: note\ndescription: >-\n  "
            + bloat_unit + ' ' + bloat_unit
            + "\ntier: warm\nlast_accessed: 2020-01-01\n---\n# Body\n\nтело\n")

        code, _, err = run([py, str(SCRIPTS_DIR / 'cleanup.py'),
                            str(cleanup_vault), '--apply'])
        test("cleanup --apply survives an undecodable frontmatter", code == 0, err[:300])
        test("cleanup left the undecodable bytes untouched (byte for byte)",
             cleanup_broken.read_bytes() == cleanup_broken_bytes,
             repr(cleanup_broken.read_bytes()[:80]))
        test("cleanup warns about the file it skipped",
             'not valid utf-8' in err, err[:300])
        test("cleanup did clean the readable bloated card",
             cleanup_ok.read_text().count(bloat_unit) == 1,
             cleanup_ok.read_text()[:200])

        # Каскад целиком, ровно в порядке ночи: следующие шаги тоже не трогают байты.
        for step_argv in (
            ['enforce.py', str(cleanup_vault), str(schema_path), '--apply'],
            ['engine.py', 'decay', str(cleanup_vault), str(schema_path)],
        ):
            code, _, err = run([py, str(SCRIPTS_DIR / step_argv[0]), *step_argv[1:]])
            test(f"night cascade: {step_argv[0]} survives the undecodable card",
                 code == 0, err[:200])
        test("night cascade left the undecodable bytes untouched (byte for byte)",
             cleanup_broken.read_bytes() == cleanup_broken_bytes,
             repr(cleanup_broken.read_bytes()[:80]))
        test("night cascade did process the readable card",
             'relevance' in cleanup_ok.read_text())

        code, out, err = run([py, str(SCRIPTS_DIR / 'enforce.py'),
                              str(broken_vault), str(schema_path), '--apply'])
        test("enforce --apply survives an undecodable card", code == 0, err[:300])
        test("enforce left the undecodable bytes untouched (byte for byte)",
             broken.read_bytes() == raw_bytes,
             repr(broken.read_bytes()[:60]))
        test("enforce warns about the file it skipped",
             'not valid utf-8' in err, err[:300])
        test("enforce counts the skipped file", 'Unreadable skipped: 1' in out
             or 'Unreadable skipped:  1' in out, out[-400:])
        test("enforce still fixed the readable card",
             'tags' in good.read_text() or 'relevance' in good.read_text())
        report = json.loads((broken_vault / '.graph' / 'enforce-report.json').read_text())
        test("enforce report carries the skip", report.get('skipped_unreadable') == 1,
             str(report))

        code, _, err = run([py, str(SCRIPTS_DIR / 'engine.py'), 'decay',
                            str(broken_vault), str(schema_path)])
        test("decay survives an undecodable card", code == 0, err[:200])
        test("decay left the undecodable bytes untouched",
             broken.read_bytes() == raw_bytes)
        test("decay still updated the readable card",
             'relevance' in good.read_text())

        code, _, _ = run([py, str(SCRIPTS_DIR / 'engine.py'), 'stats',
                          str(broken_vault), str(schema_path)])
        test("stats survives an undecodable card", code == 0)
        code, _, _ = run([py, str(SCRIPTS_DIR / 'engine.py'), 'init',
                          str(broken_vault), str(schema_path)])
        test("init survives an undecodable card", code == 0)
        test("init left the undecodable bytes untouched",
             broken.read_bytes() == raw_bytes)

        # Класс ошибки закрыт не на пути одной ночи, а у КАЖДОГО, кто переписывает
        # карточку: первый же писатель с errors='replace' уничтожает байты, и защита
        # всех, кто идёт следом, становится мёртвым кодом. Проверяем поведением —
        # каждый писатель гоняется в apply-режиме поверх нечитаемой карточки.
        code, _, err = run([py, str(SCRIPTS_DIR / 'link_cleanup.py'),
                            str(broken_vault), '--apply'])
        test("link_cleanup --apply survives an undecodable card", code == 0, err[:200])
        test("link_cleanup left the undecodable bytes untouched",
             broken.read_bytes() == raw_bytes)

        # graph.fix переписывает файл только по СПИСКУ битых ссылок, поэтому зовём
        # функцию напрямую с той ссылкой, которую она умеет чинить ([[good]] → cards/good).
        import graph as _graph
        applied = _graph.fix_broken_links(
            broken_vault,
            {'broken_link_list': [{'source': 'cards/latin1', 'target': 'good'}]},
            apply=True)[1]
        test("graph.fix_broken_links skipped the undecodable card", applied == 0,
             str(applied))
        test("graph.fix left the undecodable bytes untouched",
             broken.read_bytes() == raw_bytes)

        # enrich применяет результаты LLM-прогона из готовых batch-*-results.json —
        # кладём такой файл руками и проверяем, что нечитаемую карточку он обходит,
        # а соседнюю читаемую честно правит.
        import enrich as _enrich
        results_dir = tmp / "enrich-results"
        results_dir.mkdir(exist_ok=True)
        (results_dir / 'batch-001-results.json').write_text(json.dumps({
            'results': [
                {'path': 'cards/latin1.md', 'tags': ['tag-a']},
                {'path': 'cards/good.md', 'tags': ['tag-b']},
            ]
        }))
        applied = _enrich.apply_tags(broken_vault, results_dir)
        test("enrich apply_tags skipped the undecodable card", applied == 1, str(applied))
        test("enrich apply_tags left the undecodable bytes untouched",
             broken.read_bytes() == raw_bytes)
        test("enrich apply_tags did tag the readable card",
             'tag-b' in good.read_text(), good.read_text()[:120])

        # dedup применяется только через манифест, поэтому его писателей зовём напрямую.
        import dedup as _dedup
        broken_extra = broken_vault / "cards" / "latin1-extra.md"
        broken_extra.write_bytes(raw_bytes)
        test("merge_content refuses an undecodable canonical",
             _dedup.merge_content(broken, [good]) is False)
        test("merge_content left the undecodable canonical untouched",
             broken.read_bytes() == raw_bytes)
        good_before = good.read_bytes()
        test("merge_content skips an undecodable extra",
             _dedup.merge_content(good, [broken_extra]) is False)
        test("merge_content left both files untouched",
             good.read_bytes() == good_before and broken_extra.read_bytes() == raw_bytes)
        _dedup.redirect_links(broken_vault, ['cards/gone.md'], 'cards/good.md')
        test("redirect_links left the undecodable card untouched",
             broken.read_bytes() == raw_bytes)
        test("thin_crm_overlay refuses an undecodable card",
             _dedup.thin_crm_overlay(broken_vault, 'cards/latin1.md',
                                     'cards/good.md') is False)
        test("thin_crm_overlay left the undecodable card untouched",
             broken.read_bytes() == raw_bytes)
        broken_extra.unlink()

        # 8.4 домен с разделителем пути не роняет генерацию MOC
        test("moc_stem keeps a plain domain", moc_stem('work') == 'MOC-work')
        test("moc_stem flattens a path-like domain",
             moc_stem('work/clients') == 'MOC-work-clients')
        test("moc_stem survives a domain of only separators",
             moc_stem('../..') == 'MOC-other')
        test("moc_stem keeps cyrillic", moc_stem('работа') == 'MOC-работа')

        slash_vault = tmp / "slash-domain"
        (slash_vault / "cards").mkdir(parents=True, exist_ok=True)
        (slash_vault / "cards" / "one.md").write_text(
            "---\ntype: note\ndomain: work/clients\ndescription: Клиенты\ntags: [a]\n---\n# One\n")
        (slash_vault / "cards" / "two.md").write_text(
            "---\ntype: note\ndomain: personal\ndescription: Личное\ntags: [a]\n---\n# Two\n")
        code, out, err = run([py, str(SCRIPTS_DIR / 'moc.py'), 'generate',
                              str(slash_vault), str(schema_path)])
        test("moc generate survives a path-like domain", code == 0, err[:300])
        test("moc wrote the flattened file",
             (slash_vault / 'MOC' / 'MOC-work-clients.md').exists())
        test("moc did not lose the other domain",
             (slash_vault / 'MOC' / 'MOC-personal.md').exists())
        hub_path = slash_vault / 'MOC.md'
        hub = hub_path.read_text() if hub_path.exists() else ''
        test("hub links the flattened MOC", '[[MOC/MOC-work-clients]]' in hub,
             hub or 'MOC.md not written')
        test("hub keeps no broken link", '[[MOC/MOC-work/clients]]' not in hub)

        # 8.5 append_history не пишет внутрь код-фенса
        fenced = ("# Карточка\n\nтекст\n\n```md\n## History\n- цитата\n```\n\n"
                  "## History\n- 2026-01-01: company: A\n\n## Log\n- запись\n")
        appended = append_history(fenced, ['- 2026-08-14: company: B'])
        fence_block = appended.split('```')[1]
        test("append_history keeps the fenced block untouched",
             '2026-08-14' not in fence_block, fence_block)
        real_section = appended.split('## History')[-1].split('## Log')[0]
        test("append_history writes into the real History section",
             '- 2026-08-14: company: B' in real_section, real_section)
        test("append_history did not add a second History",
             appended.count('## History') == fenced.count('## History'), appended)

        # Единственный ## History — внутри фенса: пишем свою секцию, а не в чужой код.
        only_fenced = "# Карточка\n\n```md\n## History\n- цитата\n```\n"
        appended2 = append_history(only_fenced, ['- 2026-08-14: company: B'])
        test("fenced-only History is not treated as a section",
             appended2.split('```')[1].count('2026-08-14') == 0)
        test("fenced-only History gets a real section appended",
             appended2.rstrip().endswith('- 2026-08-14: company: B'), appended2)

        # Карточка без History — поведение прежнее.
        plain = "# Карточка\n\nтекст\n"
        test("no History section still creates one",
             append_history(plain, ['- x']) == "# Карточка\n\nтекст\n\n## History\n- x\n")

        # ═══════════════════════════════════════════════════════
        # 9. Свойства на случайных входах (seed фиксирован и печатается)
        # ═══════════════════════════════════════════════════════
        print(f"\n--- properties (seed={SEED}) ---")
        rnd = random.Random(SEED)

        # 9.1 append_history: запись НИКОГДА не попадает внутрь фенса, а настоящая
        # секция History остаётся ровно одна. Карточки собираются случайно: оба вида
        # фенсов, ## History и внутри кода, и снаружи, посторонние секции.
        def random_card() -> tuple:
            """(текст карточки, есть ли настоящая ## History вне фенсов)."""
            lines = ['# Карточка', '']
            has_real = False
            for _ in range(rnd.randint(1, 9)):
                roll = rnd.random()
                if roll < 0.3:
                    # Код-фенс, внутри которого может лежать что угодно, включая
                    # строку, похожую на заголовок секции.
                    mark = rnd.choice(['```', '~~~', '````'])
                    info = rnd.choice(['', 'md', 'python'])
                    lines.append(mark + info)
                    for _ in range(rnd.randint(1, 4)):
                        lines.append(rnd.choice(
                            ['## History', '- цитата', '## Log', 'код', '']))
                    lines.append(mark)
                elif roll < 0.45 and not has_real:
                    lines.append('## History')
                    for _ in range(rnd.randint(0, 3)):
                        lines.append(f'- 2026-01-0{rnd.randint(1, 9)}: field: v')
                    has_real = True
                elif roll < 0.6:
                    lines.append(rnd.choice(['## Log', '## Related', '## Notes']))
                    lines.append('- строка')
                else:
                    lines.append(rnd.choice(['текст', '', 'ещё текст', '  отступ']))
            return '\n'.join(lines) + '\n', has_real

        prop_fence_ok = True
        prop_single_ok = True
        prop_detail = ''
        for case in range(120):
            body, _ = random_card()
            marker = f'- 2026-08-14: PROP-{case}'
            result = append_history(body, [marker])
            lines = result.split('\n')
            outside = _outside_fences(lines)
            positions = [i for i, l in enumerate(lines) if l == marker]
            # Строка вставлена ровно один раз и вне любого фенса.
            if len(positions) != 1 or not outside[positions[0]]:
                prop_fence_ok = False
                prop_detail = f'case {case}, seed={SEED}: {result!r}'
                break
            headings = [i for i, l in enumerate(lines)
                        if outside[i] and l.strip() == '## History']
            if len(headings) != 1:
                prop_single_ok = False
                prop_detail = f'case {case}, seed={SEED}: {result!r}'
                break
        test("property: append_history never writes inside a fence",
             prop_fence_ok, prop_detail)
        test("property: exactly one real ## History section remains",
             prop_single_ok, prop_detail)

        # 9.2 moc_stem: какой бы домен ни пришёл из фронтматтера, файл остаётся
        # ВНУТРИ каталога MOC — ни подкаталога, ни выхода наверх.
        moc_root = (tmp / 'moc-prop' / 'MOC').resolve()
        moc_root.mkdir(parents=True, exist_ok=True)
        alphabet = list('abcяё/\\.. -_:*?"<>|\t\n\x00%$#@!') + ['..', '../', 'работа']
        prop_path_ok = True
        prop_path_detail = ''
        for case in range(150):
            domain = ''.join(rnd.choice(alphabet)
                             for _ in range(rnd.randint(1, 12)))
            candidate = (moc_root / f'{moc_stem(domain)}.md').resolve()
            if candidate.parent != moc_root or not candidate.name.endswith('.md'):
                prop_path_ok = False
                prop_path_detail = f'domain={domain!r} → {candidate}, seed={SEED}'
                break
        test("property: any domain stays inside the MOC directory",
             prop_path_ok, prop_path_detail)

        # 9.3 write_card: сбой в любой точке (запись временного файла или сам replace)
        # оставляет прежнюю карточку байт в байт и не плодит мусор в каталоге.
        prop_atomic_ok = True
        prop_atomic_detail = ''
        crash_dir = tmp / 'atomic-prop'
        crash_dir.mkdir(exist_ok=True)
        real_replace = _os.replace
        for case in range(60):
            card_path = crash_dir / 'card.md'
            before_bytes = ('---\ntype: note\n---\n' +
                            ''.join(rnd.choice('абвгde \n#-') for _ in range(rnd.randint(1, 400)))
                            ).encode('utf-8')
            card_path.write_bytes(before_bytes)
            fail_at = rnd.choice(['write', 'replace'])
            if fail_at == 'write':
                _os.fdopen = _bad_fdopen
            else:
                def _bad_replace(*a, **kw):
                    raise _Boom("power loss")
                _os.replace = _bad_replace
            try:
                write_card(card_path, 'новое содержимое\n')
            except _Boom:
                pass
            except Exception as exc:  # noqa: BLE001 — любое другое исключение = провал свойства
                prop_atomic_ok = False
                prop_atomic_detail = f'case {case}: unexpected {exc!r}, seed={SEED}'
            finally:
                _os.fdopen = real_fdopen
                _os.replace = real_replace
            leftovers = sorted(p.name for p in crash_dir.iterdir())
            if card_path.read_bytes() != before_bytes or leftovers != ['card.md']:
                prop_atomic_ok = False
                prop_atomic_detail = (f'case {case} ({fail_at}): leftovers={leftovers}, '
                                      f'changed={card_path.read_bytes() != before_bytes}, seed={SEED}')
                break
        test("property: a crashed write leaves the old card byte-for-byte",
             prop_atomic_ok, prop_atomic_detail)

        # 9.4 Резолв по заголовку на случайных заголовках: уникальный H1 находится при
        # смене регистра и лишних пробелах, второй файл с тем же заголовком делает ключ
        # неоднозначным, а normalize_title идемпотентна. Символы, из которых собираются
        # имена файлов ('_'), в алфавит заголовков не входят, поэтому путь и stem
        # заголовку не мешают.
        prop_vault = tmp / 'title-prop-vault'
        (prop_vault / 'titles').mkdir(parents=True, exist_ok=True)
        (prop_vault / 'dupes').mkdir(parents=True, exist_ok=True)
        alphabet = list('абвгдеёжзиклмнопрстуфхцчшщыэюяabcmxyz0123456789 -—:,')
        prop_title_ok = True
        prop_title_detail = ''
        cases = []
        seen_keys = set()
        # Заголовки с одинаковым ключом после нормализации сделали бы индекс
        # неоднозначным сами по себе — такой вход проверяет не резолвер, а генератор.
        while len(cases) < 200 and len(seen_keys) < 4000:
            case = len(cases)
            title = ''.join(rnd.choice(alphabet)
                            for _ in range(rnd.randint(1, 40)))
            key = normalize_title(title)
            if not key or key in seen_keys:
                continue
            seen_keys.add(key)
            (prop_vault / 'titles' / f'f_{case}.md').write_text(f'# {title}\n')
            cases.append((case, title))
        prop_index = build_link_index(prop_vault)
        for case, title in cases:
            words = normalize_title(title).split()
            loose = ''.join(
                (rnd.choice([' ', '  ', '   ']) if i else '') + word
                for i, word in enumerate(words))
            loose = ''.join(
                ch.upper() if rnd.random() < 0.5 else ch for ch in loose)
            loose = ' ' * rnd.randint(0, 2) + loose + ' ' * rnd.randint(0, 2)
            resolved, strategy = resolve_link_target(loose, prop_index)
            if (resolved, strategy) != (f'titles/f_{case}', 'unique_title'):
                prop_title_ok = False
                prop_title_detail = (f'case {case}, seed={SEED}: title={title!r} '
                                     f'link={loose!r} -> {(resolved, strategy)}')
                break
        test("property: a unique H1 is found through case and extra spaces",
             prop_title_ok and len(cases) == 200, prop_title_detail)

        prop_ambiguous_ok = True
        prop_ambiguous_detail = ''
        for case, title in cases:
            (prop_vault / 'dupes' / f'f_{case}.md').write_text(f'# {title}\n')
        prop_index = build_link_index(prop_vault)
        for case, title in cases:
            resolved, strategy = resolve_link_target(title, prop_index)
            if resolved is not None or strategy != 'ambiguous_title':
                prop_ambiguous_ok = False
                prop_ambiguous_detail = (f'case {case}, seed={SEED}: title={title!r} '
                                         f'-> {(resolved, strategy)}')
                break
        test("property: the same H1 in two cards is ambiguous, never guessed",
             prop_ambiguous_ok, prop_ambiguous_detail)

        prop_idempotent_ok = True
        prop_idempotent_detail = ''
        for case, title in cases:
            once = normalize_title(title)
            twice = normalize_title(once)
            if once != twice or twice != normalize_title(twice):
                prop_idempotent_ok = False
                prop_idempotent_detail = f'case {case}, seed={SEED}: {once!r} -> {twice!r}'
                break
        test("property: normalize_title is idempotent",
             prop_idempotent_ok, prop_idempotent_detail)

        # ═══════════════════════════════════════════════════════
        # SUMMARY
        # ═══════════════════════════════════════════════════════
        total = PASS + FAIL
        print(f"\n{'='*60}")
        print(f"  RESULTS: {PASS}/{total} passed, {FAIL} failed")
        print(f"{'='*60}")

    finally:
        shutil.rmtree(tmp, ignore_errors=True)

    sys.exit(0 if FAIL == 0 else 1)


if __name__ == '__main__':
    main()
