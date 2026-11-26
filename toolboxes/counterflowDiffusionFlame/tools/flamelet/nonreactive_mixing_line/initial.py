"""生成 Ember 非反应对向流的初始场。"""

import numpy as np


def build_initial_field(
    gas,
    fuel,
    oxidizer,
    Tfuel,
    Toxidizer,
    pressure,
    strain_rate,
    x_left=-0.01,
    x_right=0.01,
    n_points=101,
    mixing_width=0.001,
):
    """返回 Ember 所需的 ``x、T、Y、U、V`` 初始场。"""

    x = np.linspace(x_left, x_right, n_points)

    # s=0 为燃料流，s=1 为氧化剂流；只用于构造平滑初场。
    s = 0.5 * (1.0 + np.tanh(x / mixing_width))
    s[0] = 0.0
    s[-1] = 1.0

    gas.TPX = Tfuel, pressure, fuel
    Yfuel = gas.Y.copy()
    hfuel = gas.enthalpy_mass

    gas.TPX = Toxidizer, pressure, oxidizer
    Yoxidizer = gas.Y.copy()
    hoxidizer = gas.enthalpy_mass
    rho_oxidizer = gas.density

    # 质量分数和质量比焓按两股流的质量混合比例插值。
    Y = np.outer(Yfuel, 1.0 - s) + np.outer(Yoxidizer, s)
    h = hfuel * (1.0 - s) + hoxidizer * s

    # 根据 h、P、Y 反求温度，并计算密度。
    T = np.empty(n_points)
    rho = np.empty(n_points)
    for j in range(n_points):
        gas.HPY = h[j], pressure, Y[:, j]
        T[j] = gas.T
        rho[j] = gas.density

    # Ember 对平面 diffusion flame 使用的切向速度梯度。
    U = strain_rate * np.sqrt(rho_oxidizer / rho)

    # 在最接近 x=0 的网格点设置停滞面，并采用 Ember C++ 中
    # fixedLeft 连续方程在 drho/dt=0 时的离散形式计算 V。
    j0 = np.argmin(np.abs(x))
    V = np.zeros(n_points)

    for j in range(j0, n_points - 1):
        dx = x[j + 1] - x[j]
        V[j + 1] = V[j] - rho[j] * U[j] * dx

    for j in range(j0 - 1, -1, -1):
        dx = x[j + 1] - x[j]
        V[j] = V[j + 1] + rho[j] * U[j] * dx

    return {"x": x, "T": T, "Y": Y, "U": U, "V": V}