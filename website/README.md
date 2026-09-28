# Tinta website

The landing page of Tinta, at [usetinta.com](https://usetinta.com/). It is a static single page with no build step and no external requests. A static host serves this folder as the site root.

| Path | Content |
|---|---|
| `index.html`, `styles.css` | The page. All content is in the HTML. |
| `intro-gate.js` | Runs in the head. It selects whether the intro plays, before the first paint. |
| `main.js` | The intro, the copy buttons, and the scroll reveal. |
| `assets/` | The icons, the social preview image, and the WebP screenshots. |
| `robots.txt`, `sitemap.xml` | Keep search engines out of `experiments/`, and list the page. |
| `experiments/` | Other design directions. They are not part of the site. |

## Preview

1. Run `python3 -m http.server 4400 -d website` from the repository root.
2. Open `http://localhost:4400/`.

The intro plays a short meeting in the app window, and then the window becomes the hero. It plays once per browser session. Add `?intro` to the address to play it again. A key press, a click, a scroll, or **Skip intro** ends it. With "Reduce motion" on in macOS, or with JavaScript off, the page opens without the intro.

## Publish

The site runs on the shared Hetzner server (`178.105.63.159`), behind the edge Caddy proxy that also serves Tavola and Emulsioncamp. Every push to `main` that changes `website/` or `deploy/` deploys it: the workflow `.github/workflows/deploy-website.yml` runs `deploy/deploy.sh` on the server over SSH.

| File | Content |
|---|---|
| `deploy/tinta.caddy` | The site in the edge proxy: `usetinta.com`, and a redirect from `www`. HTTPS comes from Caddy. |
| `deploy/docker-compose.yml`, `deploy/nginx/` | The nginx container that serves this folder. `experiments/` is not served. |
| `deploy/deploy.sh` | Pulls `main` into `/opt/tinta`, updates the Caddy site with a check and a rollback, and starts nginx. |

To deploy by hand, run `ssh hetzner /opt/tinta/deploy/deploy.sh`. To deploy again from GitHub, run the workflow from the Actions tab.

The wordmark paths come from the Brush Script MT font that the app uses. Check the font license before public use.

## Experiments

`experiments/` has two other directions of the first prototype, and a page that links to them:

| Folder | Direction |
|---|---|
| `experiments/ink/` | Ink: editorial and handwritten. A drop of ink becomes the mark, and the wordmark writes itself. |
| `experiments/private/` | Stays on your Mac: dark, privacy first, and technical. |
| `experiments/_shared/` | The design brief (`BRIEF.md`) and the source assets of all directions. |

Open `http://localhost:4400/experiments/` to see them.
