# Fides colour theme

Native Jira first, with one quiet brand moment. Typographic and exact, not a finance dashboard.

## Brand accent: Fides Umber

| Surface | Hex | OKLCH | Use |
| --- | --- | --- | --- |
| Light | `#77441A` | `0.44 0.09 56` | Logo (`assets/brand/fides-logo.svg`), agent avatar, issue panel icon, the 48 px rule above the board heading |
| Dark | `#E0AB86` | `0.78 0.08 56` | Same places on dark surfaces (`assets/brand/fides-logo-dark.svg`, header rule when `useTheme().colorMode === 'dark'`) |

Rules:

- Umber appears only in the logo and the thin header rule. Never on buttons, links, focus rings, table rows or status chips.
- Standard buttons keep ADS brand blue. `color.border.focused` stays Atlassian blue.
- How it renders in UI Kit: `Box` colour values must be an ADS token or a `{ light, dark }` hex object; a raw hex string is dropped (that is why the first live build showed no bar). The bar is two layers: an inner `Box` with `{ light: '#77441A', dark: '#E0AB86' }`, over an outer `Box` with `color.background.accent.yellow.bolder`, a brown-gold token that shows through if a runtime ever drops the hex object. Thickness is `paddingBlock: 'space.025'` (4 px total), width 48 px.
- Never use blue, mint/teal, violet/purple, orange or pink accent tokens for the bar.

## Everything else: Atlassian Design System tokens

| Purpose | Token |
| --- | --- |
| Body text | `color.text` |
| Secondary text, timestamps, footer | `color.text.subtle` |
| Errors (failed scan, permission problems) | `color.text.danger` |
| Card surface (Ask Fides panel) | `elevation.surface.raised`, `elevation.shadow.raised` |
| Radius | `border.radius.200` (cards, chips), `border.radius.100` (rule) |
| Spacing | `space.025` to `space.250` |

Never hard-code neutral greys. Light and dark themes are inherited from the host.

## Status chips (colourblind-safe)

| Status | Internal | Tint (background) | Shape | Shape colour | Label colour |
| --- | --- | --- | --- | --- | --- |
| Due | RED | `color.background.danger` | filled diamond `◆` | `color.text.danger` | `color.text` |
| Upcoming | AMBER | `color.background.warning` | half-filled square `◧` | `color.text.warning` (bold glyph only) | `color.text` |
| On track | GREEN | `color.background.success` | empty ring `○` | `color.text.success` | `color.text` |

- Status is never encoded by colour alone: every chip has a unique shape and a text label.
- `color.text.warning` (`#B38600` in light) is **never** a text label. It fails WCAG AA on white (3.32:1) and on the warning tint (3.09:1). The gold only colours the bold glyph.
- Labels are always the words **Due**, **Upcoming**, **On track**.

## Contrast

- Body text on surfaces: ADS `color.text` meets AAA on default surfaces in both themes.
- Status labels use `color.text` on the subtle tints, which keeps them at AA or better.
- Focus is the ADS focus ring; nothing overrides it.
