---
name: premium-glass-ui-design
description: Guides creation of Apple-inspired, high-end UI with glassmorphism—frosted glass, subtle blur, refined typography, and premium spacing. Use when designing frontends, implementing glass/vibrancy effects, or when the user asks for Apple-like, premium, minimalist, or glassmorphism UI.
---

# Premium Glass / Apple-like UI Design

## When to Apply

Use this skill when:
- User asks for Apple-like, premium, high-end, or glassmorphism UI
- Building or refining frontend components that should feel polished and minimal
- Implementing frosted glass, vibrancy, or translucent panels

---

## Core Principles

1. **Clarity over decoration** — Every element has a purpose. No visual noise.
2. **Depth through layers** — Use blur + transparency to create hierarchy, not heavy shadows.
3. **Generous whitespace** — Let content breathe. Avoid cramped layouts.
4. **Refined motion** — Subtle, short transitions (200–350ms). Prefer ease-out or custom curves.
5. **Consistent radius** — Use a small set of border-radius values (e.g. 12px, 16px, 24px).

---

## Glassmorphism Implementation

### Base glass panel (CSS)

```css
.glass-panel {
  background: rgba(255, 255, 255, 0.08);
  backdrop-filter: blur(20px) saturate(180%);
  -webkit-backdrop-filter: blur(20px) saturate(180%);
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 16px;
}
```

Dark theme variant:

```css
.glass-panel-dark {
  background: rgba(0, 0, 0, 0.25);
  backdrop-filter: blur(24px) saturate(150%);
  -webkit-backdrop-filter: blur(24px) saturate(150%);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 16px;
}
```

### Rules

- **Blur:** 16px–24px for cards/panels; 8px–12px for small overlays.
- **Background:** Low opacity (0.06–0.15 light, 0.2–0.35 dark). Never fully opaque for “glass” surfaces.
- **Border:** 1px, same hue as background, very low opacity (0.08–0.18) to define edge without a hard line.
- **Saturate:** Slight boost (120%–180%) keeps colors behind the glass feeling alive.

### Fallback

When `backdrop-filter` is unsupported, use a solid semi-transparent background:

```css
@supports not (backdrop-filter: blur(1px)) {
  .glass-panel { background: rgba(255, 255, 255, 0.92); }
  .glass-panel-dark { background: rgba(30, 30, 30, 0.95); }
}
```

---

## Typography

- **Font stack:** Prefer system UI or a single distinctive sans: `-apple-system, BlinkMacSystemFont, "SF Pro Display", "Segoe UI", sans-serif`. For a more “Apple” feel, SF Pro (or Inter / DM Sans as fallback) works well.
- **Weights:** Regular (400) for body; Medium (500) or Semibold (600) for emphasis; avoid bold (700) for large blocks.
- **Scale:** Use a modular scale (e.g. 1.25). Typical sizes: 12–14px small/captions, 15–17px body, 20–24px headings, 28–34px hero.
- **Line height:** 1.4–1.5 body; 1.2–1.3 headings.
- **Letter-spacing:** Slight negative on large headings (-0.02em to -0.04em) for a premium look.

---

## Color & Contrast

- **Backgrounds:** Soft neutrals. Light: off-whites (#f5f5f7, #fafafa). Dark: deep grays (#1c1c1e, #2c2c2e), not pure black.
- **Text:** High contrast for readability (WCAG AA). Light bg → dark gray text (#1d1d1f). Dark bg → light gray (#f5f5f7).
- **Accents:** One primary accent used sparingly (buttons, links, key states). Muted secondary for less emphasis.
- **Avoid:** Pure black (#000) or pure white (#fff) for large areas; neon or oversaturated accents.

---

## Spacing & Layout

- **Grid:** 4px or 8px base unit. Pad content with 16px, 24px, 32px; use 48px+ for section separation.
- **Touch targets:** Min 44px height/width for interactive elements.
- **Alignment:** Prefer clear alignment to a grid; avoid arbitrary spacing values.

---

## Motion

- **Duration:** 200–350ms for UI feedback (hover, focus, open/close).
- **Easing:** `cubic-bezier(0.25, 0.1, 0.25, 1)` or `ease-out`. For “Apple” feel, slightly snappy.
- **Reduce motion:** Respect `prefers-reduced-motion: reduce` (disable or shorten animations).

---

## Do's and Don'ts

| Do | Don't |
|----|--------|
| One clear focal point per section | Multiple competing glass panels with strong borders |
| Subtle borders on glass (low opacity) | Thick or high-contrast borders on glass |
| Blur + light transparency together | Blur with opaque or near-opaque background |
| Consistent radius (e.g. 12/16/24px) | Mix of many radius values (5px, 7px, 13px…) |
| Test on real devices (blur can be costly) | Assume all devices handle heavy blur well |

---

## Quick Checklist

- [ ] Glass panels use `backdrop-filter` + low-opacity background + thin border
- [ ] Fallback for no `backdrop-filter` is a solid semi-transparent fill
- [ ] Typography uses system or one premium sans; weights and scale are consistent
- [ ] Spacing follows 4/8px base; touch targets ≥ 44px
- [ ] Animations are short and respect `prefers-reduced-motion`
- [ ] No pure black/white large areas; accent used sparingly
