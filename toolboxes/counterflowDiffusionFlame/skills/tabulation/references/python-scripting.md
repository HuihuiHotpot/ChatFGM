# 派生变量脚本编写原则

为制表样本编写派生变量脚本时，参考工具提供的 `derive_variables.py` 模板，保留模板中的函数名和参数，填写计算过程，并按模板格式返回结果。

## 写出计算公式

- 按已确认的定义直接写计算。用变量名表达物理含义。公式较长时，把有明确物理含义的中间量单独赋值，方便逐项核对。[Python Development Patterns](https://github.com/affaan-m/ECC/blob/main/skills/python-patterns/SKILL.md)
- 选择便于读懂的数组表达式或循环。计算中用到近似、经验系数或特殊处理时，用简短注释说明依据。[Python Design Patterns](https://github.com/wshobson/agents/blob/main/plugins/python-development/skills/python-design-patterns/SKILL.md)

## 试算核对

- 用一条有代表性的真实剖面试算，选一个输出值按定义独立复算，再与脚本结果比较。逐点量可以选一个网格点核对。[Testing for Numerical Code](https://github.com/a-attia/scicomp-research-skills/blob/main/skills/research-software-engineering/references/02-testing-for-numerical-code.md)
