<div align="center">
  <h1>✨ Super Clip</h1>
  <p><b>A Blazing Fast, Beautiful, and Intelligent Local Clipboard Manager</b></p>
  <p>Built with <b>Rust</b>, <b>Tauri</b>, and <b>React</b>.</p>
</div>

<br/>

## 🌟 Why Super Clip?

Super Clip is designed to be the ultimate **"Hit-App"** clipboard manager for Windows. It abandons bloated frameworks and cloud-dependent APIs in favor of **native Rust performance**, **offline ONNX machine learning**, and a breathtakingly beautiful **Obsidian glassmorphism UI**.

It doesn't just store your clips; it understands them, categorizes them, and lets you navigate your history at the speed of thought.

---

## 🚀 Core Features

### 📸 Offline Native Advanced OCR
Powered by **ONNX Runtime (`ort`)** and custom-trained DBNet/CRNN models. Super Clip can instantly and accurately extract mixed Chinese/English text from any copied image right on your local machine. No network required, zero latency, and absolute privacy.
- **Feishu-style Interaction**: Hover over any image clip to perform an instant AI text scan, then seamlessly box-select or copy the extracted segments.

### 🔍 Deep "Everything" Integration
Super Clip features a dedicated Minimalist Search Mode (`Ctrl+M`) that integrates directly with Voidtools' **Everything SDK**.
- Instantly search both your clipboard history and your entire local file system in one unified, wildly fast interface.

### ⏱️ Time-Bucket Navigation
Navigate thousands of clips effortlessly with the **Floating Time Navigator**. Clips are automatically grouped by semantic time buckets: *Within 1 Hour, Within 3 Hours, Today Morning, Yesterday, Last 7 Days*, etc. 

### 📊 Intelligent Local Insight Dashboard
A sleek built-in Dashboard analyzes your clipping habits using native JavaScript `Intl.Segmenter` API.
- See your **High-Frequency Word Stats** generated accurately and securely entirely on the client, with zero LLM dependence.
- View your content distribution across Texts, Images, Links, and Codes through beautiful interactive radial donut charts.

### 🎨 Premium "Hit-App" Aesthetics
- **Graphite & Electric Blue Palette**: A profound, professional dark mode designed for focus.
- **Glassmorphism & Vibrancy**: Native translucent layers that blend beautifully with your desktop ecosystem.
- **Dynamic Breathing Logo**: A multi-layered, visually stunning CSS-driven breathing logo that shifts colors based on your active category filter.

---

## 🛠️ Technology Stack

- **Frontend**: React 18, Vite, TailwindCSS, TypeScript.
- **Backend Core**: Rust (Tauri), `rusqlite` for database persistence.
- **Machine Learning**: `ort` (ONNX Runtime in Rust) for local neural network inference.
- **Platform**: Windows 10/11 optimized (Global dual-hotkey system, Everything SDK bridge).

## 📦 Getting Started

### Prerequisites
- [Node.js](https://nodejs.org/) (v18+)
- [Rust](https://rustup.rs/) (latest stable)
- Visual Studio C++ Build Tools (for Rust Windows compilation)
- [Everything](https://www.voidtools.com/) installed and running (for local file search functionality)

### Installation & Build

1. **Clone the repository:**
   ```bash
   git clone https://github.com/your-username/super-clip.git
   cd super-clip
   ```

2. **Install frontend dependencies:**
   ```bash
   npm install
   ```

3. **Run the development server:**
   ```bash
   npm run tauri dev
   ```

4. **Build for production:**
   ```bash
   npm run tauri build
   ```
   *The distributable `.exe` and `.msi` installers will be generated in `src-tauri/target/release/bundle/nsis/`.*

## 🔒 Privacy First
Super Clip is built on a strict **Local-First** philosophy.
- Your clipboard data never leaves your machine.
- OCR inference runs locally on your CPU/GPU.
- No telemetry, no tracking, no cloud accounts.

## 🤝 Contributing
Contributions, issues, and feature requests are welcome! Feel free to check the [issues page](https://github.com/your-username/super-clip/issues).

## 📄 License
This project is open-sourced under the MIT License.
