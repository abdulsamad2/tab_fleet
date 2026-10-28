// Points the download buttons straight at the latest release's files. Without JavaScript, or if
// GitHub's API is unreachable, the buttons keep linking to the latest-release page.
(async () => {
  try {
    const response = await fetch('https://api.github.com/repos/abdulsamad2/tab_fleet/releases/latest', {
      headers: { Accept: 'application/vnd.github+json' },
    });
    if (!response.ok) return;
    const release = await response.json();
    const assets = release.assets ?? [];
    const find = (test) => assets.find((asset) => test(asset.name))?.browser_download_url;
    const links = {
      'dl-win': find((name) => /^TabFleet-Setup-.*\.exe$/.test(name)),
      'dl-mac-arm': find((name) => /-arm64\.dmg$/.test(name)),
      'dl-mac-intel': find((name) => /\.dmg$/.test(name) && !/arm64/.test(name)),
    };
    for (const [id, url] of Object.entries(links)) {
      if (url) document.getElementById(id).href = url;
    }
    const version = document.getElementById('dl-version');
    if (release.tag_name) {
      version.textContent = `Latest version: ${release.tag_name.replace(/^v/, '')} · `;
      const all = Object.assign(document.createElement('a'), { href: release.html_url, textContent: 'all files and release notes' });
      version.append(all);
    }
  } catch {
    // Keep the fallback links.
  }
})();
