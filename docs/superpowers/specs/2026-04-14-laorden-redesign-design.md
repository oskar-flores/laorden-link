# La Orden Website Redesign — Design Spec

## Overview

Full redesign of the Asociación Lúdica La Orden single-page website (www.laorden.org). Replace the current generic dark+gold AI aesthetic with "The Dark Forge" direction: warm charcoal-brown + burnished copper. Add a dynamic events section with poster image support. No framework — static HTML/CSS/JS hosted on GitHub Pages.

## Design Direction: The Dark Forge

### Palette (OKLCH-based)

| Token | Hex | Role |
|-------|-----|------|
| `--bg-deep` | `#0D0906` | Page background |
| `--bg-warm` | `#1A1008` | Section gradient endpoint |
| `--bg-panel` | `rgba(255,255,255,0.03)` | Card/panel surfaces |
| `--copper` | `#C47832` | Primary accent |
| `--copper-light` | `#D4924A` | Hover/interactive accent |
| `--copper-glow` | `rgba(196,120,50,0.08)` | Ambient glow |
| `--text-light` | `#F0E6D6` | Primary text (parchment) |
| `--text-muted` | `#8A7560` | Secondary text |
| `--border-subtle` | `rgba(196,120,50,0.12)` | Default borders |
| `--border-accent` | `rgba(196,120,50,0.25)` | Hover/active borders |

All neutrals are tinted toward the copper hue for subconscious cohesion.

### Typography

- **Display:** Young Serif (Google Fonts) — warm, slightly chunky serif with personality. Not on any overused list.
- **Body:** Karla (Google Fonts) — friendly grotesque with slightly quirky proportions.
- **Scale:** Fluid sizing with `clamp()` for headings. Fixed `rem` for body.
- **Hierarchy:** Large display headings (clamp 2.2rem–3.5rem), section titles (clamp 1.8rem–2.4rem), body at 1rem, labels at 0.75rem uppercase with wide tracking.
- **Line length:** Capped at ~65ch for body text.

### Theme Rationale

Dark theme is correct for this audience (gamers gathering in the evening, fantasy RPG context). The warm brown undertone (not cold blue-black) and copper accent (not metallic gold) differentiate from the generic AI gaming site pattern.

## Page Structure

### 1. Navigation (fixed)

- Logo image (logo.jpg, 42px circle with copper border) + "LA ORDEN" in Young Serif
- Fixed top, blurred background (`backdrop-filter: blur(12px)`)
- Bottom border: subtle copper

### 2. Hero

- Full-viewport background using existing `hero.png`
- Image treatment: `brightness(0.45) sepia(0.15)` + radial vignette to `--bg-deep`
- Content: "Donde nacen las leyendas" headline (copper emphasis on "las leyendas"), subtitle, "Est. 2025" tagline
- Two CTAs: "Únete al Gremio" (primary copper) + "Próximos Eventos" (ghost)
- Fade-up entrance animation

### 3. Events Section (NEW)

**Data source:** A `const EVENTS` JavaScript array at the top of `index.html`. Each event object:

```js
const EVENTS = [
  {
    title: "Star Wars Day",
    date: "Domingo 3 de Mayo",
    image: "events/starwars-may2025.jpg",
    description: "Jornada especial de rol y juegos de mesa...",
    tags: ["Torneo", "Rol", "Juegos de Mesa", "Gratis"],
    link: "https://forms.google.com/..." // optional sign-up URL
  }
];
```

**How to add an event:**
1. Drop poster image into `events/` folder
2. Add an object to the `EVENTS` array
3. Commit and push

**Rendering rules:**
- If `EVENTS` array is empty: show "Próximamente..." message
- Events render as horizontal cards: poster image on the left (380px, full height, `object-fit: cover`), details on the right
- Poster images display large enough for QR codes to be scannable
- On mobile: stack vertically (image on top, details below)
- Tags rendered as copper pill badges
- Optional "Apúntate" CTA link if `link` is provided

### 4. Activities ("Nuestros Dominios")

- Section label "NUESTROS DOMINIOS" + title "Qué hacemos"
- 3-column grid (1 column on mobile)
- Cards with existing SVG icons reused:
  - D20 polyhedron → Juegos de Rol
  - Shield → Estrategia & Wargames
  - D6 dice → Juegos de Mesa
- Cards: subtle panel background, copper icon, hover lift + border accent

### 5. App Download

- Centered section with gradient background
- "Únete a la Aventura" heading
- Brief description
- Two store buttons (App Store + Google Play) with existing SVG icons
- Ghost button style, copper hover

### 6. Contact ("Sede del Gremio")

- 2-column grid: info on left, map on right
- Info blocks: Dirección, Contacto (email link), Misión
- Labels: copper uppercase small tracking
- Map: embedded Google Maps iframe, grayscale filter that reveals color on hover
- No decorative corner brackets (removed from original)

### 7. Footer

- Single line: "La Orden © 2025 · Asociación Lúdica"
- Copper border top, muted text

## Responsive Behavior

- **Desktop (>768px):** Full grid layouts, side-by-side event cards
- **Mobile (<=768px):** Single column throughout. Event poster stacks above details. Activity cards stack. Contact info stacks above map.
- No framework, no breakpoint library. Single `@media (max-width: 768px)` block.
- `grid-template-columns: repeat(auto-fit, minmax(...))` not used for activities — explicit 3-col to 1-col switch keeps it simple.

## Assets

- `hero.png` — existing hero background image (keep as-is)
- `logo.jpg` — existing logo (keep as-is)
- `events/` — new directory for event poster images
- No external dependencies beyond Google Fonts (Young Serif + Karla)

## What's Removed from Current Site

- Cinzel + Lato fonts → replaced by Young Serif + Karla
- Cold blue-black palette (`#0B0C10`) → warm brown-black (`#0D0906`)
- Gold accent (`#C5A059`) → burnished copper (`#C47832`)
- Decorative card top gradients → removed
- Info card `border-left: 3px solid` → removed (banned pattern)
- Map decorative corner brackets → removed
- Vignette using `radial-gradient(circle, ...)` → simplified with `ellipse`

## What's Added

- Events section with JS-driven rendering
- `events/` directory for poster images
- Two CTA buttons in hero
- Section labels (small uppercase copper text above titles)
- Cleaner responsive handling

## Tech Stack

- Single `index.html` file with embedded `<style>` and `<script>`
- No build step, no framework, no dependencies
- Google Fonts loaded via `<link>` tags
- Vanilla JS for event rendering (~30 lines)
- GitHub Pages hosting (existing CNAME: www.laorden.org)

## Out of Scope

- CMS or admin panel for events (edit the array directly)
- Multi-page navigation
- Dark/light mode toggle (dark only)
- i18n (Spanish only)
- 404.html redesign (separate task)
