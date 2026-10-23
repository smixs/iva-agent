import fallback from "../data/stats.json";
export async function getStats() {
  try {
    if (process.env.SITE_OFFLINE === "1") throw new Error("offline build");
    const get = async (suffix: string) => {
      const response = await fetch(
        `https://api.github.com/repos/smixs/iva-agent${suffix}`,
        {
          headers: { Accept: "application/vnd.github+json" },
          signal: AbortSignal.timeout(4000),
        },
      );
      if (!response.ok) throw new Error(`GitHub ${response.status}`);
      return response;
    };
    const [repo, releases, contributors] = await Promise.all([
      get(""),
      get("/releases?per_page=1"),
      get("/contributors?per_page=1&anon=1"),
    ]);
    const count = async (response: Response) => {
      const last = response.headers
        .get("link")
        ?.match(/[?&]page=(\d+)>; rel="last"/);
      return last ? Number(last[1]) : (await response.json()).length;
    };
    return {
      stars: (await repo.json()).stargazers_count,
      releases: await count(releases),
      contributors: await count(contributors),
    };
  } catch {
    console.log("[stats] GitHub unavailable; using checked-in stats.json");
    return fallback;
  }
}
export const stats = await getStats();
