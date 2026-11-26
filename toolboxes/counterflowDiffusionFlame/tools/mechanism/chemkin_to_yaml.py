"""将 CHEMKIN 机理转换为 Cantera YAML。"""
import argparse
from contextlib import redirect_stdout
import json
from pathlib import Path
import sys

import cantera as ct


def convert_chemkin(input_file, output_file, thermo_file, transport_file):
    if not thermo_file or not transport_file:
        raise ValueError("必须提供热力学文件和输运文件的路径。")
    output = Path(output_file)
    output.parent.mkdir(parents=True, exist_ok=True)
    with redirect_stdout(sys.stderr):
        from cantera import ck2yaml
        ck2yaml.Parser.convert_mech(
            input_file=str(input_file),
            thermo_file=str(thermo_file),
            transport_file=str(transport_file),
            out_name=str(output),
        )
    gas = ct.Solution(yaml=output.read_text(encoding="utf-8"))
    return {"output_file": str(output), "species_count": gas.n_species,
            "reaction_count": gas.n_reactions}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", dest="input_file", required=True)
    parser.add_argument("--output", dest="output_file", required=True)
    parser.add_argument("--thermo", dest="thermo_file", required=True)
    parser.add_argument("--transport", dest="transport_file", required=True)
    result = convert_chemkin(**vars(parser.parse_args()))
    print(json.dumps(result))
