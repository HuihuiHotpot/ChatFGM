"""根据 Ember 初始混合线计算最大绝热平衡温度。"""

import cantera as ct


def calculate_Tad(mechanism_file, pressure, T, Y):
    gas = ct.Solution(str(mechanism_file), transport_model=None)
    Tad = float("-inf")

    for j, Tj in enumerate(T):
        gas.TPY = Tj, pressure, Y[:, j]
        gas.equilibrate("HP")
        Tad = max(Tad, gas.T)

    return Tad