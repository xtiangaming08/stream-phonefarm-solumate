## Donation

If you find this project useful and would like to support continued development/maintenance:

- **MoMo:** `0799640848`
- **VietinBank:** `0799640848` — **Đoàn Thanh Lực**

Thank you for your support! 🙏

---

# Solumate Stream Project (English)

This project includes two parts:
- **server**: backend API
- **client**: frontend

This guide helps **beginners** install and run the project.

---

## Prerequisites

- **Node.js 20.x (recommended 20.xx)**
- npm (bundled with Node.js)

> If you are using a different Node.js version, please install **Node 20.x** to avoid dependency issues.

---

## 1) Install Node.js 20.x

1. Go to the official Node.js website and download **Node.js 20.x (LTS)**:  
   https://nodejs.org/
2. Choose the installer for your OS (Windows/macOS/Linux) and install it normally.
3. Verify the installation:

```bash
node -v
npm -v
```

`node -v` should show something like `v20.xx.x`.

---

## 2) Install & Run the Server (Backend)

Open a Terminal (or PowerShell/CMD) in the project root folder and run:

```bash
cd server
npm i
npm run start
```

- `npm i`: install dependencies
- `npm run start`: start the server

> If the server requires a `.env` file, make sure it is configured according to the project instructions (if any).

---

## 3) Install & Run the Client (Frontend)

Open **a new Terminal** (recommended) and run:

```bash
cd ../client
npm i
npm start
```

- `npm i`: install dependencies for the client  
- `npm start`: run the client in development mode

---

## 4) Recommended workflow

Run them **in parallel**:
- Terminal 1: **server**
- Terminal 2: **client**

This allows the client to call the server API during development.

---

## Troubleshooting

### 1) Wrong Node.js version
If you see syntax/dependency errors, check your Node.js version:

```bash
node -v
```

Node **20.x** is recommended.

### 2) Dependency install issues / corrupted cache
Try removing `node_modules` and reinstall:

**macOS/Linux:**
```bash
# inside server or client folder
rm -rf node_modules package-lock.json
npm i
```

**Windows PowerShell:**
```powershell
Remove-Item -Recurse -Force node_modules
Remove-Item package-lock.json
npm i
```

---


## License

See `LICENSE` for licensing details.
