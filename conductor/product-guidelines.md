# Soundsible: Product Design & Interaction Guidelines

These guidelines define the "Cyber-Premium" aesthetic and interaction language for the Soundsible ecosystem, ensuring a high-end, tactile experience that bridges the gap between modern design and technical precision.

## 1. Visual Language: Glassmorphism & "Paper-Code"
The UI should feel like a sophisticated blend of a high-end physical music player and a modern code editor.

- **Surface Treatment:** Heavy use of `backdrop-filter: blur()`. Surfaces should be semi-transparent frosted panels.
- **Aesthetic Fusion:** Apple-inspired clean layouts meeting JetBrains-inspired technical accents.
- **Color Themes:**
    - **Dark Mode (Default):** Deep charcoal/black backgrounds with light yellow (`#F7DF1E` JS-style) accents for primary actions, progress bars, and active states.
    - **Light Mode:** High-brightness "Paper" (Off-white) backgrounds with deep yellow/amber accents.
- **Shadows & Depth:** Use soft, large-radius shadows to create a sense of elevation for floating components like the Queue Popover and Action Menus.

## 2. Typography Hierarchy
Typography is used to distinguish between the "Music" and the "Station."

- **Primary Text (Titles, Sections):** A clean, bold sans-serif (e.g., Inter or system-native bold) for readability and impact.
- **Technical Metadata (Artist, Album, Format, Path):** **JetBrains Mono Nerd Font**. This emphasizes the project's "Home Station" and audiophile identity.
- **Data Density:** Maintain a minimalist layout by default. Use "Dynamic Density" where technical details (bitrates, sample rates) elegantly expand or reveal upon tapping.

## 3. Interaction & Animation Physics
Soundsible animations must be fast, tactile, and responsive—silky like Apple's but optimized for a high-speed interaction cycle.

- **Physics Engine:** Use "Slime" and "Magnetic" spring curves (`cubic-bezier(0.175, 0.885, 0.32, 1.275)`). Elements should "snap" and "pop" into place.
- **Gesture Orchestration:**
    - **Horizontal Swipes:** For quick actions (Queue, Favourite) with instant visual indicators.
    - **Vertical Drags:** For dismissing views (Now Playing, Menus) with "Magnetic Slide" release logic.
- **Haptic Feedback:**
    - **Heartbeat Pulse:** For long-press menu triggers.
    - **Clean Click Pulse:** For successful toggles and selections.
- **Zero-Latency Feel:** Never force the user to wait for an animation to finish before the next interaction can be registered.

## 4. Messaging & Feedback
- **Tone:** Technical yet immersive. Informative without being cluttered.
- **Feedback:** Provide immediate, high-fidelity confirmation for background tasks (e.g., "Surgically updating library...") using non-intrusive Toast notifications.
- **State Integrity:** Surgical DOM updates only. Avoid full-page refreshes to maintain the immersion of the frosted, glassmorphic environment.
