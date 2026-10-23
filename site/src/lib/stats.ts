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
    const [repo, contributors] = await Promise.all([
      get(""),
      get("/contributors?per_page=1&anon=1"),
    ]);
    let releases = 0,
      page = 1,
      hasNext = true;
    while (hasNext) {
      const response = await get(`/releases?per_page=100&page=${page}`);
      const entries = (await response.json()) as { tag_name: string }[];
      releases += entries.filter((release) =>
        release.tag_name.startsWith("v"),
      ).length;
      hasNext = Boolean(response.headers.get("link")?.includes('rel="next"'));
      page++;
    }
    const last = contributors.headers
      .get("link")
      ?.match(/[?&]page=(\d+)>; rel="last"/);
    const result = {
      stars: (await repo.json()).stargazers_count as number,
      releases,
      contributors: last
        ? Number(last[1])
        : ((await contributors.json()).length as number),
    };
    if (!Object.values(result).every(Number.isFinite))
      throw new Error("Invalid GitHub stats");
    console.log(
      `[stats] ${result.stars} stars; ${releases} Iva releases (v* only); ${result.contributors} contributors`,
    );
    return result;
  } catch {
    console.log(
      "[stats] GitHub unavailable; using stats.json: 265 stars, 70 releases, 11 contributors",
    );
    return fallback;
  }
}
export const stats = await getStats();
