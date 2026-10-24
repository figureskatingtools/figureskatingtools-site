# figureskatingtools.com sign-in branding (Entra External ID)

Applied on 2026-10-23. Apply it in the External ID tenant `380073b3-804e-4cc7-bfcc-843637630d04`: Entra admin center › Custom branding › Default sign-in › Edit. That tenant serves both test and prod, so the change shows on both sign-in pages at once.

## Files

| File | Where it goes | Size and limit |
|---|---|---|
| `favicon-32.png` | Basics › Favicon | 32×32, 1.5 KB of 5 KB |
| `background-1920x1080.jpg` | Basics › Background image | 1920×1080, 36 KB of 300 KB |
| `header-logo-245x36.png` | Header › Header logo (white) | 245×36, 5 KB of 10 KB |
| `banner-logo-245x36.png` | Sign-in form › Banner logo (ink) | 245×36, 5 KB of 50 KB |
| `square-logo-light-240.png` | Sign-in form › Square logo (light theme) | 240×240, 32 KB of 50 KB |
| `square-logo-dark-240.png` | Sign-in form › Square logo (dark theme), optional | 240×240, 32 KB of 50 KB |
| `custom.css` | Layout › Custom CSS | colours, pill buttons, card, inputs, footer |

Every file comes from the site's own brand files: `site/public/landing/img/mark.png`, `favicon.png`, `papers-1600.webp`, and Fraunces for the "FSTools" wordmark. The background is the landing page hero: the greyscale papers photo under the same ink-to-rink shade.

## Settings

1. **Basics**
   - Favicon and background image: the files above.
   - Page background color: `#0d1f33`.
2. **Layout**
   - Template: Full-screen background.
   - Header: Show.
   - Footer: Show.
   - Custom CSS: `custom.css`.
3. **Header:** `header-logo-245x36.png`.
4. **Footer**
   - Privacy & Cookies: show, with text `Privacy notice` and URL `https://figureskatingtools.com/privacy/`.
   - Terms of Use: show, with text `Terms of use` and URL `https://figureskatingtools.com/terms/`.
5. **Sign-in form**
   - Banner logo and square logos: the files above.
   - Username hint text: `Email`.
   - Sign-in page text:
     `Access is by invitation. [Privacy notice](https://figureskatingtools.com/privacy/) · [Tietosuojaseloste](https://figureskatingtools.com/tietosuoja/) · [Terms of use](https://figureskatingtools.com/terms/)`
   - Self-service password reset: off. There are no password accounts.
6. **Text:** Sign in › description: `Tools for figure skating result services`.

Also set **Tenant properties › Name** to `figureskatingtools.com`. That name appears in the verification e-mails.

## Check after saving

- Open the test app's Run user flow with the tenant-ID host. Look for the background, both logos, the gold Next button, the intro line and the links at the bottom of the card.
- Microsoft notes that custom footer URLs can show as plain text. If they aren't clickable, the same links in the sign-in page text still are.
- The pages on Microsoft's (personal account) and Google's own sites keep their own look.

## Notes

- **Fonts:** the sign-in page can't load the site's web fonts. `custom.css` falls back to Georgia for the title and the system UI font for the rest, and the mockups show exactly that.
- **CSS properties:** `custom.css` sets only colours, type, borders, radius, shadow and inner spacing. It uses none of the layout or positioning properties Microsoft is retiring from custom CSS. External ID tenants aren't affected by that retirement yet.
- **Rebuilding the images:** from the repo root, `uv run --with pillow --with fonttools --with brotli python infra/branding/make_assets.py site/public infra/branding <scratch dir>`.
