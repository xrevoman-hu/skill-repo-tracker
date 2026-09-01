# Skill 同步与文件系统 Rules

- `skill_library_root` 是唯一事实源，工具目录是发布副本。
- 只删除本应用在 `skill_sync_records` 中登记的副本；同名未知目录永不推断所有权。
- 更新/恢复使用锁、同文件系统临时路径、校验和原子替换。
- ZIP 扫描与落盘目录必须共享同一 canonical 文件树摘要语义：只纳入常规文件的相对路径与内容字节，并按相对路径组件排序；同一远端树在下载侧和临时目录复验侧必须得到相同摘要。
- 旧摘要兼容只允许绑定到同一已固定远端 SHA，且必须由本次下载内容独立复算命中 legacy digest；相关 handled/conflict 状态还须精确匹配原 SHA 与旧摘要，迁移后只写 canonical digest，其他不匹配继续 fail closed。
- 检查后到执行前目标可能变化（TOCTOU）；执行时必须重新验证 canonical path 和所有权。
- 取消同步目标不等于立即删除；批量应用时先备份并记录结果。
