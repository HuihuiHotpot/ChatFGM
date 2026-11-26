"""定位 Ember 瞬态着火计算所需的混合线 restart 文件。"""

from pathlib import Path


def mixing_line_case_name(Tfuel, Toxidizer, pressure_pa, strain_rate):
    Tf, To, p, a = (
        str(float(value)).removesuffix(".0")
        for value in (Tfuel, Toxidizer, pressure_pa, strain_rate)
    )
    return f"Tf={Tf} K_To={To} K_p={p} Pa_a={a} s-1"


def find_mixing_line_restart(
    mixing_line_root,
    Tfuel,
    Toxidizer,
    pressure_pa,
    strain_rate,
):
    """匹配工况并返回最终混合线 ``prof000001.h5`` 的路径。"""

    case_name = mixing_line_case_name(Tfuel, Toxidizer, pressure_pa, strain_rate)
    restart_file = Path(mixing_line_root) / case_name / "prof000001.h5"

    if not restart_file.is_file():
        raise FileNotFoundError(
            f"Mixing-line restart file not found for case '{case_name}': "
            f"{restart_file}"
        )

    return str(restart_file)
