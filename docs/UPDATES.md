# 自动更新发布流程

`tauri.conf.json` 里的 `updater` 段已经写好占位配置。**默认 `active: false`** —— 因为没有签名密钥时启用 updater 会让客户端在启动时白白报错。下面是真正启用前必须做的事。

## 一、生成签名密钥（一次性）

Tauri 的 updater 用 minisign 签名校验下载的更新包，避免中间人篡改。

```bash
npx @tauri-apps/cli signer generate -w ~/.tauri/super-clip.key
```

生成两个文件：

- `super-clip.key` —— **私钥**，绝不能进 git。建议丢密码管理器或 1Password。
- `super-clip.key.pub` —— 公钥，要嵌进 `tauri.conf.json` 的 `pubkey` 字段。

## 二、配置 GitHub Actions secret

在仓库 → Settings → Secrets and variables → Actions 里新增：

- `TAURI_PRIVATE_KEY` —— 私钥的内容（cat super-clip.key）
- `TAURI_KEY_PASSWORD` —— 生成密钥时设的密码

## 三、修改 tauri.conf.json

把 `pubkey` 字段值替换成 `super-clip.key.pub` 的内容（一行 base64 字符串），把 `active` 改成 `true`：

```json
"updater": {
    "active": true,
    "endpoints": ["https://github.com/huangmang/super-clip/releases/latest/download/latest.json"],
    "dialog": true,
    "pubkey": "dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ24..."
}
```

## 四、发布流程

每次发版（在 GitHub Actions 的 release workflow 里）：

1. `npm run tauri build` 产出 `.msi` / `.exe.sig` / `.exe`
2. 生成 `latest.json`（结构如下）：

```json
{
    "version": "0.5.1",
    "notes": "本次更新内容...",
    "pub_date": "2026-05-08T00:00:00Z",
    "platforms": {
        "windows-x86_64": {
            "signature": "<.sig 文件内容>",
            "url": "https://github.com/huangmang/super-clip/releases/download/v0.5.1/super-clip_0.5.1_x64-setup.exe"
        }
    }
}
```

3. 把 `.exe` / `.msi` / `latest.json` 一起上传到对应的 GitHub Release。

之后任何运行 v0.5.0+ 客户端的用户在启动时都会自动检查 `endpoints`，发现新版本时弹出对话框（因为 `dialog: true`），用户点击「立即更新」就完成下载 + 签名校验 + 静默安装。

## 跳过更新检查

用户可以在 Settings 里关掉自动检查（待实现）。当前阶段还没接 UI，临时方案：把 `tauri.conf.json` 的 `active` 改回 `false` 重发一版。

## 兼容性注意

- Tauri 1.x 的 updater 是内置的（`tauri::updater`）。Tauri 2 改成了独立 plugin（`@tauri-apps/plugin-updater`），未来迁移到 Tauri 2 时这部分配置要重新做一遍。
- macOS / Linux 的 updater 行为不同，需要分别配置 macOS 的 `.app.tar.gz` 和 Linux 的 `.AppImage`。当前 README 主要面向 Windows，跨平台 updater 留作后续。
