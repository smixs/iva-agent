import fallback from "../data/stats.json";
// Stars for the header counter; the only number the site shows.
export async function getStats() {
  try {
    if (process.env.SITE_OFFLINE === "1") throw new Error("offline build");
    const response = await fetch("https://api.github.com/repos/smixs/iva-agent", {
      headers: { Accept: "application/vnd.github+json" },
      signal: AbortSignal.timeout(4000),
    });
    if (!response.ok) throw new Error(`GitHub ${response.status}`);
    const stars = (await response.json()).stargazers_count as number;
    if (!Number.isFinite(stars)) throw new Error("Invalid GitHub stats");
    console.log(`[stats] ${stars} stars`);
    return { stars };
  } catch {
    console.log(`[stats] GitHub unavailable; using stats.json: ${fallback.stars} stars`);
    return fallback;
  }
}
export const stats = await getStats();
