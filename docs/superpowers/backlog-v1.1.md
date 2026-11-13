# v1.1 Backlog 与携带项（v1.0 合并时固化）

- 日期：2026-11-07
- 来源：最终全分支审查 triage + 12 个任务 gate 的 deferred minors
- 说明：本文件替代已删除的 SDD 工作区 ledger，作为下一批工作的输入

## v1.1 主线：跨仓库差异统计（已确认需求）

- 两个仓库对应同一个项目：GitHub `jingwang-0415/dsh` + Gitee `wj160415/dsh2`
- 两仓提交历史**独立**（SHA 对不上）→ 需 **patch-id 补丁指纹**匹配，产物是"疑似同一改动"语义（灰色标注），非确证
- 分支对应：**同名直接配对**（main↔main）
- 核心视图：跨仓库对比——同名分支的双向独有提交数/列表 + patch-id 疑似配对统计
- 需要多仓库 UI（v1.0 仅服务 repos[0]；数据模型 repo_id 已预留）
- merge 提交无补丁指纹、冲突解决差异会导致漏配——界面语义必须如实
- 已知 demo 脚本：两仓同历史起步 → 制造双向受控分叉 → 验证识别

## 修复批（carry，优先级从高到低）

1. classifyChange 仅 exitCode===1 判"非祖先"，基础设施故障（超时/ENOENT）应传播为失败（refDiff.ts:30-32 现把一切归为 force-push → 误标 rewritten 且漏收提交，下轮无 diff 不纠正）
2. SSE 心跳：加 25s comment ping 防中间层空闲超时（retry: 3000 已有，浏览器自动重连兜底）
3. /api/commits limit 加上限封顶（如 500，防 limit=100000 重查询）
4. 损坏窗口期上游删分支：重克隆回填路径对"DB 有 vs 快照有"做差集补 markBranchDeleted（现永久 active+陈旧 head）
5. spec §8 两处偏差回写：503 {code,message} 未落地；`since` 参数被 offset 分页替代（另：路由为 /api/commits?branch= 而非 /api/branches/:name/commits，已有文档）
6. gitRunner GitCommandError/超时消息对 args 做凭证脱敏（url 内嵌 token 会进 fetch_events 并上 UI）
7. /api/branches 串行 spawn 算 behindDefault（100 分支秒级）+ recentCommits 无索引——接真实大仓后观察，必要时并行化/加索引
8. 测试卫生：mkdtemp 统一清理钩子；api.test compare 用例与 inclusion 用例的声明顺序耦合；smoke close try/finally；analyzer.test 死代码
9. scheduler stop→start 双 timer 链（需 epoch 令牌；现状仅节奏抖动）；start() 不幂等
10. handler 抛错丢该轮事件（提交已入库、下轮 diff 空不补发）——设计如此，文档化

## 已裁决不变的语义（防止未来误"修"）

- cherry-pick ≠ 包含（SHA 祖先判定），如如实标注；patch-id 疑似匹配是 v1.1 的增强不是修正
- first_seen_at 24h 红徽标随时间过期，不依赖已读状态
- behindDefault = defaultBranch 独有提交数（analyzer base 视角），api.ts:69 取 .ahead 正确

## v1.1 执行后新增 carry（最终 scoped 审查裁定）

- vue-tsc 类型门（v1.2 第一件事；StatusChangedEvent 失真、api.test 旧形状 SSE fixture 均因无门无人察觉）
- Compare 视图 repo 作用域成套接通 + Overview 徽标跳转带 repo + 跨仓行 CommitDetail 直链（detail API 需 repo 作用域先行）——v1.2 成套做
- showCommits 分批（ARG_MAX）+ git log -p 补丁文本流式化（大仓化）
- SSE 心跳 25s comment ping；spec §8 503/since 回写
- multirepo.test publish.mockRestore 移入 afterEach（当前为文件末位测试无泄漏面）

## v1.1 裁定存档（摘要）

- patch-id 空匹配=合法空集；同秒 SHA 碰撞先例贯穿 v1.1 三处测试；include 行为测试与 HTTP→引擎缝断言 uplift 合并前必修（已完成）；matchedPairs 排序回写 spec（时间倒序）；文档字面三处回写随修复批落地

---

# v1.2 收官附录（2026-11-09，main@fcb0feb）

## v1.3 池（最终 scoped 审查裁定，按优先级）

1. **classifyChange exitCode 区分**（v1.3 首位，两个周期 carry 已够）：refDiff.ts 把基础设施故障（超时/ENOENT）归为 force-push，且 force-push 路径不插入提交 → 这些提交在 head 再次前进前永久漏报
2. /api/commits limit 上限 clamp（一行）
3. gitRunner 凭证脱敏（url 内嵌 token 会进 fetch_events/UI，两行）
4. sse.ts publish/sweep 尾部补 stopHeartbeatIfIdle（两行，闭环心跳停表）
5. RouterLink 改对象式 `:to`（顺带补 api.test toContain 子串弱断言）；Compare 切仓 requestId 时序守卫；SHOW_BATCH 导出；afterAll try/finally；vue-tsc 门翻出的 branches.updated fixture 补齐
6. spec §8 503/since 回写

## 流程备注（下批修正）

- task-brief 预生成漏了两次（T2/T4）——派发步骤加"简报生成"固定动作
- review-package 的"squash 包含"表述与多提交历史不符——打包脚本注明实际提交数
- 需求映射表应显式处置未决的 v1.0 carry（勿静默滚存）

## 已解决标注

- ✅ "Compare 视图 repo 作用域成套接通"——v1.2-T1 已解决（合并时验证：Compare 下拉/作用域调用/查询持久化/徽标带 repo/跨仓直链/CommitDetail 读 ?repo= 全部落地并受测试锁定）
- ✅ 测试临时目录卫生——v1.2-T4 trackTmp/cleanupTracked 全覆盖（53/53 调用点，零残留探针通过）
- ✅ SSE 心跳——v1.2-T4 惰性 25s（真实实例 31s 探针实测 1 次）

---

# v1.3 收官附录（2026-11-09，仓库管理界面）

## 已交付

- 界面直接配置仓库：/repos 管理视图（列表/添加/删除/状态徽标）+ Overview 入口
- POST/DELETE /api/repos：原子回写 config.json（唯一真源）、免重启 Scheduler 构建/停止、DB 历史保留（同 id 重挂接续）
- C1 封死：repo id 拒绝 `.`/`..`（数据目录删除链——mirrorDirFor 归一化 + CORRUPT_RE rmSync 的组合逃逸），前后端同款校验
- I1 保底：DELETE 最后一个仓 → 409 last_repo（防 repos:[] 重启崩溃）
- GET /api/repos 暴露 branchExclude（UI 可见性）

## carry（v1.4 候选）

- repos upsert SQL 双份抽公共（api.ts/app.ts 注释互锚）
- upsert 后抛错的 typed 500 模式补全（近不可能场景）
- configOverride 缺 configPath 强制成对/派生临时路径
- 单仓部署换仓需"先加后删"的操作顺序写进 README
- 大小写不敏感 FS 上 r1/R1 镜像目录碰撞（可选 lowercase 规范化）
- DELETE 不 join 在飞 runOnce 的语义文档化（README）

## 流程备注

- v1.3 全程无 Critical/Important 逃逸到合并；最终 scoped 审查抓到的 C1（设计正则未考虑路径专名）与 I1（min(1)×UI 删除交互未审视）均属计划层缺陷，gate 前修复

---

# v1.3.1 收官附录（2026-11-09，轮询间隔运行时可调）

## 已交付

- PATCH /api/repos/:id：轮询间隔/默认分支/排除 glob 运行时原位变更（引用语义即时生效）+ 原子回写 + 回滚纪律
- /repos 视图行内编辑（URL 只读明示、前端先行校验、错误横幅 message 优先）
- 轮询间隔上界 604800 秒（7 天，三处同阈值：config zod .max / PATCH 手写校验 / 前端本地拦截——防 setTimeout 1ms 钳制紧循环）
- README 运行时可调说明补交付

## v1.4 候选（本周期新增，Enter-to-save 优先）

- Repos 行内编辑 Enter 保存（@keyup.enter）；编辑中切行丢弃输入提示；.url-cell 灰化仅编辑态
- branchExclude:[] 重置路径显式断言；DB upsert try/catch 收编 typed 500 模式
- api.test compare 断言改精确 URL/URLSearchParams 解析（消 toContain 子串弱点）；RouterLink 统一对象式 :to

---

# v1.3.2 收官附录（2026-11-09，传输兜底 + 手动同步 + 深色模式对比度）

## 已交付

- 按仓传输兜底：bypassGitConfig（GIT_CONFIG_GLOBAL/SYSTEM=/dev/null 直连）+ httpProxy 三分支语义（undefined=跟随系统/''=强制无代理/非空=显式代理）——解决内源代理劫持 git 全局配置的场景（劫持 fixture 对照组实证）
- **Critical 修复**：超时 kill 留孤儿孙进程持管道 → 'close' 永不触发 → 调度器互斥永久卡死（线上活体实锤）——kill 整树 + 销毁五流强制 close，复现测试确定性锁定
- POST /api/repos/:id/sync 手动同步端点 + Overview"立即同步"按钮（互斥安全 skipped、四分支横幅）
- 传输设置 UI：表单/行内编辑"传输（高级）"区 + 表格传输标记（三分支载荷构造 transportFields 单点封装）
- 深色模式对比度：.btn 根因（1.4:1→12.9:1）、表单控件、9 badge/banner 变体、行系/链接/分隔线全量显式配色
- README 传输兜底与手动同步用法段（含 '' 断连警示、bypass 边界、credential 提醒）

## v1.4 池（v1.3.2 新增汇总）

- 代理模式三态下拉（跟随系统/强制直连/自定义代理——一并解决 PATCH 棱角、表格 '—' 合流、undefined→'' 迁移）
- 切仓横幅守卫（await 前存 target 落横幅前比对）；Overview 测试补抛错红/无新提交灰/切仓清三分支
- 进程组 kill（孤儿清剿终态）；runGit input 路径 stdin 销毁对称；syncButton 非空断言工效学
- reposapi 文件级 cleanupTracked（顺修既有同款）；POST /sync 上限或异步任务化；GIT_CONFIG_NUL Windows 脚注
- RouterLink 对象式 :to 统一（消 toContain 子串弱点）；Enter 保存；v1.0 carry 三项（classifyChange/limit clamp/凭证脱敏）

## 流程备注

- review-package 打包脚本注明实际提交数（squash 包含表述与多提交历史不符，两次复审者被误导）
- task-brief 预生成固定为派发前动作（本周期两次遗漏）
- 需求映射表显式处置未决 carry（勿静默滚存）

---

# v1.4 收官附录（2026-11-11，加固与体验批次）

## 已交付

- classifyChange 归因分级：exitCode 1/128（非祖先/镜像缺对象）→ force-push；spawn error/timeout → rethrow 走调度器失败轮退避（基础设施故障不再误标 rewritten + 漏收提交）
- GitCommandError/超时消息凭证脱敏（sanitize 三层：构造器/超时/pipeRunGit，fetch_events 与 UI 泄漏面封死）
- /api/commits limit 钳制 [1,500]（NaN/0/负数 400，超量静默钳制）
- SSE 心跳停表闭环：publish/sweep 摘除后补 stopHeartbeatIfIdle（三路停止收敛）
- 代理三态下拉「网络连接方式」（跟随系统/强制直连/自定义代理）——PATCH 棱角、表格 '—' 合流、undefined→'' 迁移一并解决；PATCH httpProxy null 显式 unset + snapshot ?? null 哨兵
- UX 批次：Enter 保存、CrossRepo 对象式 :to（消 & 劈查询串 bug 类）、切仓横幅守卫（双落笔路径）、Overview 三分支测试、multirepo afterEach、reposapi 文件级清理、传输字段注释修正、黑洞测试代理 env 清空（共享 util）
- v1.0 carry 三项全部闭环（最终审查核实 ✓）

## v1.5 池（v1.4 最终审查 recommendations）

- 快照对账机制（周期比对 DB head_sha vs 镜像 head——classify 分级后残余的检出推进丢失窗口）
- bypass+代理双设行显示与用例；.edit-proxy Enter；branchExclude:[] 清空测试；死参数清理；limit 500 魔数常量化
- 直连措辞碰撞（bypass checkbox vs 三态直连——机制不同，文案区分）；POST 契约类型层 null 表达
- 进程组 kill（孤儿清剿终态，需 detached 权衡）；runGit input 路径 stdin 销毁对称（生产无 input 调用点，理论角落）

## 流程备注

- 门禁实践：代理劫持机器上跑聚焦测试后再宣布全绿（黑洞测试 flake 曾在对抗 env 下复现——已修）

---

# v1.5 收官附录（2026-11-12，指定 git 配置 + AI 工程文档 + 一键跑通）

## 已交付

- 按仓 gitConfigPath：GIT_CONFIG_GLOBAL=<指定文件> 映射（与 bypass 互斥 refine + API 生效态互斥；PATCH null 显式 unset 与 httpProxy 先例同构；existsSync 时点校验 400 git_config_not_found）
- AI 工程文档五层渐进式披露：AGENTS.md 入口（41 行）/概览/架构/服务端 15 模块/web 5 视图/约束红线与已知坑（60+ 处引用抽验零失实）
- scripts/doctor.sh（5 项体检+修复提示）+ scripts/setup.sh（幂等装配）+ package.json 薄封装 + README 依赖清单与一键跑通段

## 运维事故复盘（重要）

- 多次"重启"仅杀 bash 包装层，node 子进程存活持端口——验收首_run 打到陈旧 v1.3.1 僵尸进程（其 scheduler 挂起 fetch 亦系旧代码超时缺陷）。**固定步骤：重启前 ps+lsof 核实端口归属与进程树全灭**
- 僵尸进程内的挂起 fetch（SIGKILL 留孤儿）经手动 kill -9 孤儿树后立即落定 ok——与 4cd6e09 修复机制互证（该修复后新进程不会再挂）

## v1.6 池

- reposapi describe 级 cleanupTracked 泄漏（v1.4 遗留，文件级收敛后待差集补）
- POST 400/409 定序契约化；gitConfigPath 运行中被删的 git 报错呈现（lifecycle 文档化）
- AI 文档"空 -c 对"措辞修正（Minor 5，随下次文档维护）

---

# v1.6 收官附录（2026-11-13，界面重构 Element Plus）

## 已交付

- Element Plus 按需引入（AutoImport/Components + ElementPlusResolver；js 480K 其中 ElMenu popper 链为主）+ html.dark 类驱动主题体系（localStorage 显式 > prefers 缺省 + 手动切换按钮持久化）+ el-container 布局骨架
- 五视图全迁移：el-table（hidden-columns 双渲染陷阱→tbody 前缀定位收敛）/el-alert 四态/el-tag 徽标/el-form 校验/ElMessage 瞬时提示/el-popconfirm #actions 插槽/el-descriptions/el-collapse/el-select disabled 未配对禁选
- 业务语义零回归（切仓守卫/三分支载荷/互斥联动/对象式 :to/复制/删除确认五视图逐一在场）；测试 45→48（业务断言保留 + Compare 冒烟 ×3 + 未配对禁选首锁）
- EP 陷阱知识工程化：hidden-columns 哑上下文影子克隆、teleported 是 prop 不落 DOM attribute（防回归锚定渲染位置）、transition stub 内层断言——全部写进测试头注释
- style.css 从 ~300 行精简至 45 行（死类 grep 零消费后删；暗色 input 双边框负债整删）

## v1.7 池（v1.6 最终审查 carry）

- isDark 系统跟随失同步（OS 翻转后首点固化旧主题，二次自愈）；applyTheme 降非导出；el-menu nav landmark
- label→span 丢控件关联 ×12（aria-label 一行式/收敛）；badge() 双调用与 effect 默认/bannerText 残留名
- Compare 双列串拼接经可达性分析不升级（server 白名单+深链失败双重不可达）——已顺手修+冒烟 ✅；折叠组件语言统一（el-collapse vs details）；error 态 ElMessage duration:0 兜底；selectedLabel 失败语义
- teleported=false 弹层在 .el-main overflow:auto 内短视口底部边缘可能裁（目检项）；error-alert 无 margin 贴脸

## 运维与流程备注

- **重试固定流程已固化**：重启前 ps+lsof 核实端口归属与进程树全灭（v1.5 验收首_run 打到僵尸进程事故的落地）
- **双重派发事故复盘**：T2 双代理并发单树（zz-*/EpProbe 双探针互报）→ 冻结双方+控制器独立验证门禁+合并态提交（a462dd0）；红线=同一任务单次 tool call 派发，dispatch 后未见响应先 list_agents 核对
- brief 计数勘误机制：ledger 计数会滞后于实际（测试随周期增长），每任务以实测基线回归并声明
