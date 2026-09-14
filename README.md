# APK Hub（OneShotAPK）

线上地址：https://oneshotapk.siecho.cn （push 即自动部署）

本机各会话产出的 Android APK 汇总下载站。Vercel 部署，push 即自动重新部署。

## 结构
```
public/index.html        手机站首页：清单 + 二维码 + 下载按钮（QR 库已自托管于 public/vendor/）
public/apks/manifest.json  清单（唯一数据源）
public/apks/<id>/*.apk   安装包本体（随仓库提交）
api/apps.js              GET /api/apps[?id=]  JSON 接口
vercel.json              .apk 的 Content-Type / 缓存 / CORS
tools/add_apk.py         摄入接口：拷贝 APK + 写清单（--commit / --push）
scripts/publish.sh       提交并用 deploy key 推送（push 触发 Vercel 部署）
keys/                    deploy 私钥（.gitignore 已排除私钥，仅 .pub 入库）
```

## 添加一个 APK（其他会话用这个）
```bash
python D:/ApkHub/tools/add_apk.py \
  --apk <apk路径> --id <slug> --name "名称" --version 1.0.0 \
  --desc "一句话介绍" --abi arm64-v8a --engine "Godot 4.7.2" --min-sdk 24 \
  --tags a,b --extra "模拟器 x86_64=<另一个apk>" \
  --commit --push --message "apk: add <slug>"
```
同 id 重复添加会覆盖旧条目与文件。清单更新后 push 即上线；下载直链为
`https://oneshotapk.siecho.cn/apks/<id>/<文件名>.apk`。

## 部署（owner 一次性配置）
1. GitHub 仓库 `Siechonya/OneShotAPK` → Settings → Deploy keys → 添加
   `keys/vercel_deploy_ed25519.pub` 的内容，**勾选 Allow write access**。
2. vercel.com → Add New → Project → Import 该仓库（框架 Preset: Other，
   Root Directory: 默认根目录即可）。
3. 之后任何 `bash scripts/publish.sh "msg"` 都会 push 并触发部署。

## 限制
- Vercel 单文件 ≤ 50MB；超大包请拆分或改用对象存储。
- 仓库即存储：APK 进 git 历史，删除文件不会缩小仓库。
- 页面不收集任何数据；无后端写接口（摄入只走本机脚本 + git）。
