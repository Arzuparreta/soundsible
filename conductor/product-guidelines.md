# Soundsible: Product Design & Interaction Guidelines

These guidelines define the "Cyber-Premium" aesthetic and interaction language for the Soundsible ecosystem, ensuring a high-end, tactile experience that bridges the gap between modern design and technical precision.

## 1. Visual Language: Glassmorphism & "Cyber-Premium"
The UI should feel like a sophisticated blend of a high-end physical music player and a modern code editor.

- **Surface Treatment:** Heavy use of `backdrop-filter: blur(40px)`. Surfaces should be semi-transparent frosted panels.
- **Aesthetic Fusion:** Apple-inspired clean layouts meeting JetBrains-inspired technical accents.
- **Color Themes:**
    - **Dark Mode (Default):** Deep charcoal (`#0d0d0f`) backgrounds with JetBrains Orange (`#f97a12`) accents for primary actions, progress bars, and active states. Selection background uses a very dark orange (`#4a2a0a`).
    - **Light Mode (Paper):** Off-white (`#f5f5f5`) backgrounds with TypeScript Blue (`#3178c6`) accents.
- **Shadows & Depth:** Use soft, large-radius shadows to create elevation for floating components like the Queue Popover and Action Menus.

## 2. Typography Hierarchy
Typography is used to distinguish between the "Music" and the "Station."

- **Primary Text (Titles, Sections):** **Plus Jakarta Sans**. A clean, bold sans-serif for readability and impact.
- **Technical Metadata:** **JetBrains Mono**. This emphasizes the project's "Home Station" and audiophile identity.
- **Data Density:** Maintain a minimalist layout by default.

## 3. Interaction & Animation Physics
Soundsible animations must be fast, tactile, and responsive—silky like Apple's but optimized for a high-speed interaction cycle.

- **Physics Engine:** Use the "Premium Slime" curve (`cubic-bezier(0.19, 1, 0.22, 1)`) for all major transitions.
- **Navigation (Scrub-Nav):**
    - **Scrub Pill:** A translucent glassmorphic pill at the bottom center. Horizontal drags "scrub" through views with tactile haptic pulses.
    - **Quick-Jump HUD:** Long-pressing the Player Bar reveals a 2x3 navigation grid for instant switching.
    - **Card Deck Transitions:** Views slide OVER each other. Outgoing views dim and scale down slightly (`scale(0.96)`) to create depth.
- **Platform Safety (Mobile):**
- **Notch Safety:** Use `env(safe-area-inset-top)` and `env(safe-area-inset-bottom)` religiously.
- **Safari Integration:** Use `overscroll-behavior-x: none` and `touch-action: pan-y` to block system gestures from interfering with custom navigation.
- **Interaction:** Prefer `active:` states over `hover:` for mobile buttons to prevent "sticky" highlights.
