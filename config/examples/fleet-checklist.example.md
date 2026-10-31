---
id: example-exit-ok
owner: example-owner
check: node -e "process.exit(0)"
deadline: 24h
escalate: example-lead
evidence: example-probe
---

示例：一行只读 shell。退出码 0 表示这条成立。

---
id: example-manual
owner: example-owner
check: manual
deadline: 7d
escalate: example-lead
evidence: example-review
sampler: example-sampler
frequency: weekly
---

示例：需要人读改动。标成 manual，并写明抽检人和频率，不假装机器可检。
