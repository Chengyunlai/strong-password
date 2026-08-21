# Edge Beta 发布说明

版本：0.2.0 Beta

本版针对公开测试补充了：

- 移除常驻全站 content script 和 `<all_urls>` host permission；填充改为用户点击后通过 `activeTab` + `scripting` 临时执行。
- 弹窗保持打开时 5 分钟无操作自动锁定保险库，关闭弹窗会立即丢弃解锁密钥。
- 复制密码后 30 秒尽力清空剪贴板（若用户已复制其他内容则不覆盖；浏览器权限或关闭弹窗可能使清理无法执行）。
- 增加扩展图标与 Beta 风险提示。

请在 Edge 商店的 Privacy 页面说明：数据只保存在本地，不上传密码；在 Store listings 页面标注 Beta，并提供公开 HTTPS 隐私政策 URL。
