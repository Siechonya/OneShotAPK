# APK Hub

线上地址：https://oneshotapk.siecho.cn

一个汇总下载 Android 安装包的静态站点。Vercel 部署，推送到仓库即自动重新部署。

## 目录结构
```
public/index.html           手机站首页：应用清单 + 二维码 + 下载按钮（QR 库自托管于 public/vendor/）
public/apks/manifest.json   清单（唯一数据源）
public/apks/<id>/*.apk      安装包本体
api/apps.js                 GET /api/apps[?id=]  JSON 接口
vercel.json                 .apk 的 Content-Type / 缓存 / CORS
tools/add_apk.py            摄入脚本：拷贝 APK 并写清单（--commit / --push）
scripts/publish.sh          提交并推送（push 触发自动部署）
```

## 发布一个新的 APK
```bash
python <hub>/tools/add_apk.py \
  --apk <apk路径> --id <slug> --name "名称" --version 1.0.0 \
  --desc "一句话介绍" --abi arm64-v8a --engine "Godot 4.7.2" --min-sdk 24 \
  --tags a,b --extra "模拟器 x86_64=<另一个apk>" \
  --file-name "<中文展示名>-<版本>-<abi>.apk" \
  --commit --push --message "apk: add <slug>"
```

同一个 `id` 重复添加会覆盖旧条目与旧文件。对外文件名用 `--file-name` 指定展示名
（例如 `示例应用-1.0.0-arm64.apk`），不要把 debug / unsigned 之类的构建字样发布出去。

站点文本与清单均为 UTF-8；中文文件名在 URL 中为百分号编码。
下载直链形如：`https://oneshotapk.siecho.cn/apks/<id>/<文件名>.apk`

## 说明
- 页面不收集任何数据，也没有后端写接口：摄入只在本机执行，然后通过 git 发布。
- 仓库同时充当存储：安装包会进入 git 历史，删除文件不会缩小仓库体积。
- 单文件体积受部署平台限制（Vercel 单文件 ≤ 50MB）。
