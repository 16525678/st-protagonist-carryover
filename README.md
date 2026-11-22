# 主角跨聊天传承（适配龙血玄黄·数据库）

这是一个面向 **SillyTavern（酒馆）** 与 **TauriTavern** 的纯前端扩展插件，专门搭配 **[AlbusKen/shujuku](https://github.com/AlbusKen/shujuku)（龙血玄黄·数据库）** 使用，让你把旧聊天里养出来的主角带进另一个新聊天（同卡二周目或全新世界观角色卡），不用整库覆盖、也不花任何额外 AI API 费用。

> 📋 版本更新记录请查看 [CHANGELOG.md](./CHANGELOG.md)。

---

## 核心功能

1. **双通道导出主角**
   - 在旧聊天中直接读取 `window.AutoCardUpdaterAPI.exportTableAsJson()`；
   - 或直接上传龙血玄黄导出的 `TavernDB_checkpoint_*.json` / 表格 JSON 文件；
   - 自动预选「主角信息表」「主角技能表」「背包物品表」，也支持自由勾选其他表的特定行、直接改字微调后存入本地「主角传承库」。
2. **跨聊天不同表规则自动适配（写回数据库）**
   - 自动解析目标聊天每张表的 `DDL` 与 `note` 规则：识别**单行表/多行表**、`NOT NULL` 必填列、`DEFAULT` 默认值、`INTEGER/REAL` 数字类型、`CHECK(... IN (...))` 合法枚举、`UNIQUE` 唯一键与 `GLOB` 格式；
   - 自动完成同义列匹配（如 `人物名称` ↔ `姓名`、`职业/身份` ↔ `身份`）与复合列拆合（如 `性别/年龄` ↔ `性别` + `年龄`），也支持手工微调每一列的映射或固定值；
   - 写前做红/黄/绿体检预览，遇 `UNIQUE` 重名可选「覆盖更新 / 跳过 / 数量累加」；
   - **未写入的剩余信息零丢失**：目标表装不下的列或表（例如从奇幻卡带去恋爱日常卡的技能表），会自动收纳成「补充提示词」，写表后可一键同步注入当前聊天。
3. **纯提示词注入（无数据库 / 通用跨世界）**
   - 目标聊天没开数据库时，直接将主角档案渲染为 `<主角传承档案>` 绑定到当前聊天，切去其他聊天自动清空、互不串台。

---

## 安装步骤（新手版）

### 方式一：酒馆内粘贴 GitHub 网址一键安装（最推荐）
1. 打开 SillyTavern 右上角 **扩展（立方体图标）** → 点击 **安装扩展（Install Extension）**。
2. 粘贴本仓库地址：
   ```text
   https://github.com/16525678/st-protagonist-carryover
   ```
3. 点击保存/安装，完成后按 `Ctrl + F5` 刷新网页即可。

### 方式二：手动复制文件夹安装
1. 找到你电脑上 SillyTavern 的扩展存放目录（二选一，推荐第 1 个）：
   - **用户目录（推荐，ST v1.12+）**：`SillyTavern/data/default-user/extensions/`（如果你开了多账号，把 `default-user` 换成你的用户名）
   - **全局目录（通用）**：`SillyTavern/public/scripts/extensions/third-party/`
2. 把整个 `st-protagonist-carryover` 文件夹复制进去，确保里面的 `manifest.json` 路径类似：
   `.../extensions/st-protagonist-carryover/manifest.json`
3. 刷新 SillyTavern 网页（必要时按 `Ctrl + F5` 强刷）。

安装完成后，可以通过以下任一方式打开工作台：
- **手机端最推荐**：点击聊天输入框旁的 **魔法棒菜单** → 点击 **「主角跨聊天传承」**；
- **桌面/通用**：打开酒馆右上角 **扩展（立方体图标）** → 点开 **「主角跨聊天传承（龙血玄黄数据库）」** 抽屉；
- **快捷命令**：在聊天输入框发送 `/carryover`。

> 📱 本插件已做**桌面端 + 手机端双端适配**（适配 TauriTavern Android/iOS/PC 与 SillyTavern）：手机端自动切换全屏竖排卡片、按行点「编辑」才弹出输入法防卡顿，并提供「复制 / 粘贴 JSON」方便跨设备备份。

---

## 三步上手

1. **旧聊天导出**：进入老存档 → 点「打开主角传承工作台」→ 在 **「1. 导出主角」** 点「从当前聊天数据库读取」（或上传 Checkpoint 文件）→ 勾选要带走的表和行、顺手改字 → 点「保存到主角传承库」。
2. **切去新聊天**：打开另一个角色卡的新聊天（如果准备写回数据库，确保新聊天已有角色开场白）。
3. **继承主角**：再次打开工作台 → 切到 **「2. 继承到当前聊天」** → 选刚才保存的主角：
   - 新聊天也开了数据库：检查列映射和下方「写前规则体检」，有红字按提示选好值后点 **「确认写回当前聊天数据库」**；
   - 新聊天没开数据库：切到 **「模式 B：纯提示词注入」**，检查文本后点 **「应用到当前聊天」**。

---

## 本地离线验证命令

```powershell
# 1. 运行跨表规则引擎与适配器自动化测试
node --test tests/schema-engine.test.mjs

# 2. 检查语法
node --check index.js
node --check src/schema-engine.js
node --check src/acu-adapter.js
node --check src/prompt-injector.js
node --check src/storage.js
node --check src/ui.js
```
