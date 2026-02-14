# Soundsible: Universal Media Station

Soundsible is a modular music ecosystem that lets you manage and stream your personal music library anywhere. Whether your music is on a Local NAS, Cloud Storage (R2/S3), or you're downloading it on the fly, Soundsible provides a unified experience on your desktop and mobile devices.

## 🚀 Quick Start

1.  **Launch the System**:
    ```bash
    python3 run.py
    ```
    - **On Linux**: Opens the high-fidelity GTK Player.
    - **On Windows**: Opens the Control Center for library management.

2.  **Access Remotely**:
    - Select **Option 3** in the CLI or use the **Daemon Mode** (`--daemon`).
    - Open the provided URL on your phone or remote browser.

---

## 📱 User Manual (Web Player)

The Web Player is a Progressive Web App (PWA) designed for your phone.

### Library Management (Tactile Gestures)
- **Play**: Simply tap a song to start listening.
- **Favourite**: **Swipe Right** on any song row to instantly mark it as a favourite (Yellow circle).
- **Delete**: **Swipe Left** to remove a song from your Station (requires confirmation).
- **Sync**: The library automatically refreshes whenever you switch tabs.

### Remote Downloads
- Go to the **Downloads** tab to grow your library from anywhere.
- Paste multiple Spotify or YouTube URLs into the box and click **Add to Queue**.
- Click **Start Processing** to begin the download to your Home Station.
- Browse your Spotify playlists and liked songs directly to bulk-add them to your queue.

---

## 🌐 Connectivity & Networking

### The "Home Station"
Soundsible operates on **Port 5005**. If you are away from home, you must be connected to your Station via **Tailscale** or a similar VPN for the best experience.

### Mobile & Tailscale (Highly Recommended)
- **Zero Configuration**: Pin your Station's Tailscale IP in the Web Player settings.
- **Seamless Handoff**: Stay connected as you move between your home Wi-Fi and mobile data.
- **Secure**: All traffic is end-to-end encrypted.

---

## 🛠 Advanced Information
For detailed system architecture, API specifications, and advanced deployment options, please refer to the **[Advanced Documentation](ADVANCED.md)**.

---

## License
This project is licensed under the MIT License.
