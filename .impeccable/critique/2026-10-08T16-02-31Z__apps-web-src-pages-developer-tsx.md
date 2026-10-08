---
target: ArcPreflight current Demo and Developer lifecycle readiness
total_score: 23
p0_count: 0
p1_count: 12
timestamp: 2026-10-08T16-02-31Z
slug: apps-web-src-pages-developer-tsx
---
Method: dual-agent (A: /root/online_button · B: /root/design_detector)

# ArcPreflight current lifecycle audit — 2026-10-08

结论：本地产品闭环的页面和主要正路径已补齐；之前的问题没有全部修复；当前版本适合受控测试网演示，尚不适合无人指导的公开钱包试用。线上仍为旧版 89c269f。不要把“372 tests passed”解释为异常恢复、资金状态和验证结果均正确。

## 检查范围与证据

- 当前工作树 HEAD 为 8c59d10，存在大量未提交修改；本报告针对本轮读取与测试时的快照。
- 本轮实际执行 pnpm -r --no-bail test：372/372 通过；全仓 typecheck、API/Web build 通过。
- 本轮用模拟 RPC / 内存库复现 4 项后端异常，不产生链上交易；额外复跑 verifier 负例。
- 本轮浏览器实际检查本地 Demo/Developer、公开线上 Developer。使用不具备签名/发送能力的占位钱包检查订单窗口：空值校验 → Autofill → 金额改成 0.004 → 手动参考号 → Review，未创建订单。
- 390px DOM 检查时订单窗口宽 352px、文档宽 390px，无横向溢出；不等于所有移动端流程均验收。
- 当前保存的最新测试网 lifecycle 记录确有成功与恢复结果；本轮没有重跑真实钱包付款，没有签名、领水、转账或主网消费。

## 已完成的改动

1. Developer 已接上创建订单、审批、收费检查、钱包执行、恢复、导出、验证七步流程。未连接钱包有明确提示。
2. 完整订单窗口存在：付款人为已连接地址，可选择场景、填金额和参考号；Autofill 后仍能编辑，提交前可复核。
3. Demo 有成功、待审核、金额错误三类场景，以及成功场景下的模拟广播中断按钮。
4. 订单先记录身份再发送、逐阶段 artifacts、session 所有权、主网执行门禁已存在。
5. fee authorization 全字段核对、费用总额重算、RPC 不支持历史时 UNVERIFIED 的修复仍有效。
6. nonce 冲突恢复现在要求识别实际消费交易及回执，避免仅因节点数据不同步而过早判 NOT_MINED。

## 发布前必须处理的正确性问题

| 优先级 | 问题与证据 | 用户影响 / 修复要求 |
|---|---|---|
| P1 | 最新真实 wallet passport 的审批历史删掉或改为 revoked，APPROVAL_COVERAGE 仍 PASS。verify.ts:208 以 signedTransactionHash 作为检查开关，钱包模式此值为 null。 | 根据实际执行模式与执行事实校验审批，缺历史 UNVERIFIED，撤销或过期 FAIL。 |
| P1 | 没有 browser hash 的恢复路径只找到 OrderPaid 就可关闭 CONFIRMED/SUCCESS；mock 中 receipt=null、deviations=null、未读实际交易。wallet.ts:220。 | 付款结果和计划一致性必须分别证实；无回执/交易时保留未决，不许用事件替代计划比较。 |
| P1 | 同订单两个并发 createAttempt 均返回 201，形成 2 条 VALIDATED。wallet.ts:87。 | 在 RPC 之前事务占位/约束唯一活动 attempt，避免重复签名机会；本轮未证明发生双重本金扣款。 |
| P1 | runner 12 次 artifact 保存全部抛错，仍发交易并 SUCCESS。runner/index.ts:104。 | 必需付款证据持久化失败应阻断付款；不能把恢复所需数据当作可丢弃日志。 |
| P1 | snapshot 已有 30 秒，策略最大 5 秒，finalValidate 仍 PASS 并发送。validate.ts:83。 | 按 snapshot 的实际观察时间和付款窗口判断新鲜度，不从慢 RPC 完成时重新开始计时。 |
| P1 | API 与 Passport 费用来源不一致。最新 interrupt API buyer total=0.06，Passport=0.0610091；wallet API operator=0.0025073，Passport=0.004685625。 | 共用同一完整成本快照。未知 Gas 应显示“合计未完整”，不能以 0 汇总成最终 total。 |
| P1 | Continue in wallet 未在实际调用前重新检查付款人、链和窗口；使用当前 account 覆盖 plan.from，交易请求未带 chainId。attempts.ts:86–95。 | 恢复签名前重新读取并匹配账户/链/期限；过期应重新验证，不向钱包交付旧计划。 |
| P1 | 钱包返回非拒绝错误时仍 VALIDATED，页面可 Continue 或 Abandon(nothing sent)。attempts.ts:98、AttemptPanel.tsx:50。 | 将可能已广播与确实未发送分开；先查原 attempt，再开放重试。 |
| P1 | A 钱包切换 B 后只显示 foreign 警告，旧流程仍在 state，随后可持久化为 B 的流程。Developer.tsx:162/185。 | 按网络+付款人隔离流程；切换时冻结或清空活动订单/检查/attempt。 |
| P1 | verifier 任何返回结果都 setVerified(true)，包含 FAIL/UNVERIFIED；有 hash 但 deviations 未知时也显示绿色 as planned。Developer.tsx:518，AttemptPanel.tsx:41。 | “验证已完成”与“所有必要项通过”分开；未比较必须显示未验证。 |
| P1 | 无钱包提示推荐 ?testwallet=<key>；该功能无生产限制，读取 URL 私钥并存 localStorage。wallet.ts:117，testWallet.ts:16，main.tsx:8。 | 公开构建移除该提示并禁用私钥测试注入；仅隔离开发测试环境启用。 |

额外未完成：未决 reservation 默认 0 且导入值可任意修改后仍通过；缺 verification-profile.json 仍全 PASS；明显过期的审批记录仍 PASS。runner 先写终态再写最终 artifacts 存在崩溃不一致窗口（index.ts:242、API db.ts:91）；示例 CLI 未接 orderStore/onArtifact（examples/merchant-agent/src/run.ts:76）。

负例脚本：/tmp/arcpreflight-v33-passport-latest-audit.mts、/tmp/arcpreflight-v32-passport-audit.mts；后端四项 mock 在 /var/folders/1z/3g2cx2kj2j39z3g972d8fjgw0000gn/T/arc33-readonly-repro-j86myx28/repro.test.ts。

## 设计健康度

评分为本轮交互评审判断，0 差、4 优秀，不是测试通过率。

| Nielsen 准则 | 分数 | 主要依据 |
|---|---:|---|
| 状态可见 | 3 | 七步和历史齐全，部分绿标含义过强 |
| 符合用户语言 | 2 | proxy、calldata、6/18 位等压过付款目的 |
| 用户控制 | 2 | 可编辑与恢复，但重试边界不可靠 |
| 一致性 | 3 | 视觉统一，模式与付款人措辞存在冲突 |
| 错误预防 | 1 | 钱包恢复守卫、并发与过期问题 |
| 减少记忆负担 | 3 | 流程可见，但折叠失效 |
| 效率 | 2 | Autofill 有效，跨页钱包试用路径复杂 |
| 简洁 | 2 | 所有未来步骤内容与技术细节同时出现 |
| 错误恢复 | 2 | 入口完整，未知状态解释与判断仍有缺陷 |
| 帮助 | 3 | 文档详尽，缺更简单的用户任务叙述 |
| 合计 | 23/40 | 主要流程有形，未达到可放心自助试用 |

## 视觉与反模式判断

A 评审认为深色、衬线标题和黄色主要操作形成统一视觉；问题主要是信息层次、真实状态和用户决策，而非需要重新装修。不要因为检测器匹配某种风格就机械改色或换字体。

## 最有价值的体验修正

1. **P1：让七步真正折叠。** StepSection.tsx:18 的 hidden 被 styles.css:417 的 display:flex 覆盖。本轮浏览器直接读出 step2–7 hidden=true，却仍 display:flex 且有可见高度。默认只打开当前一步，完成后保留金额与结果摘要。对应 impeccable harden / distill。
2. **P1：真实表达结果。** 未查明不是零、未知不是符合计划、完成验证不是验证通过。将这些作为组件状态契约，而非仅调整颜色。对应 impeccable harden。
3. **P2：两个清楚的入口。** “观看项目出资演示”和“用我的钱包体验”。Demo 默认先完整成功付款，再展示被拦截、广播后中断恢复；Developer 承担完整钱包流程。连接钱包不应隐含切换收费模式。对应 impeccable onboard / clarify。
4. **P2：签名前统一显示费用。** 展示检查费、订单金额、Gas上限、支付者和是否测试币。CostTable.tsx:19 在 runner 模式也写 your wallet，应按实际 payer 显示。领水门槛固定0.05，没有覆盖默认0.05订单+0.01检查费+Gas，也没随手填金额变化；应在购买报告之前检查完整预算。对应 impeccable clarify / harden。
5. **P2：用任务语言解释订单。** 先给“模拟订单、金额、付款人、参考号、预期结果”；明确没有真实商品交付，报告/付款结果/Passport 才是体验产物。MAIN/CHANGED 改成“正常付款/合约已变化”场景名，ABI、原子单位、API JSON 放到技术详情。Demo.tsx:140 可点击 div 改为可键盘操作的 button/radio。对应 impeccable distill / onboard / audit。

## 用户画像走查

- 首次使用者：连接提示清楚，但其后需理解多个链上概念；无插件提示包含不应公开的私钥测试入口；默认待审核场景可能让人再次认为产品只提供检查。
- 有钱包的开发者：Autofill/编辑/确切请求是优点；账户切换、报告过期、provider超时后的续跑是主要失误点。应提供检查前余额预算和单一“下一步”。
- 只用键盘或手机者：首页场景卡不是键盘控件；步骤并未隐藏；成本表窄屏隐藏 unresolved 列，需要给出同等可见摘要。仅订单弹窗390px无横向溢出已核对，其他窄屏流程需补验。

## 建议的演示脚本与验收顺序

观看：免钱包 → 自动生成明确标注的模拟订单 → 检查 → 成功支付 → 显示本金/费用/Gas归属 → 下载并验证Passport；随后可切换合约变化拦截与中断恢复，展示恢复新增订单/签名/收费均为0。

试用：连接钱包 → 切到正确测试网 → 明确全部预算并按需领水 → Autofill或手填 → Review → 标明收费的检查签名 → 业务付款签名 → 回执/订单/计划一致性 → Passport → 有明确FAIL/UNVERIFIED结果的验证。

先修证据/恢复/付款守卫，再修折叠和文案；之后用真实钱包扩展验证账户切换、拒签、超时、断网刷新、余额不足、报告过期、RPC滞后。最后才冻结版本、部署并重验公开URL。

## 次要观察与问题处理

缺 scoped PRODUCT.md 不阻断本次审查；可以在后续产品整理时补充受众、两种体验模式和费用原则。无需为本次结论追加用户选择题：当前优先级由付款正确性与已复现缺陷决定。Questions skipped: review-only scope and clear correctness-first priority.

## 独立检测交叉核验

Assessment B 对 Developer.tsx、Demo.tsx、OrderDialog.tsx、CostTable.tsx、AttemptPanel.tsx 的静态检测均为0条；加载后的浏览器检测分别19条/11条。水合前5条结果丢弃。检测器主要匹配字体、暗色发光、侧边条、大小写、行长等样式；这些不能直接推出设计不合理。保留熟悉字体与有语义的状态颜色，不把它们列为发布阻断。

B 独立在浏览器证实：折叠体隐藏属性被覆盖；3个场景卡均为 DIV、无 role、tabIndex=-1；未连接钱包查看项目runner记录仍写 YOUR WALLET；business gas unavailable 时 buyer total 仍显示0.06。B 与 A 在这些具体行为上相互印证。

静态扫描为0说明不能以扫描结果代替交互验收。核心问题来自状态和流程语义，而非风格词匹配。

## 截图证据

本轮浏览器截图保存在 /tmp/arc-current-ui-audit/：developer-disconnected.png、developer-connected.png、demo-current.png、order-autofill.png、order-reviewed.png、production-developer.png、order-mobile.png。占位provider无私钥，已断开、移除并关闭测试tab。
