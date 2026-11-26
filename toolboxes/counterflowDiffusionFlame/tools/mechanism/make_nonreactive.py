"""保留物种、热力学和输运模型，生成零反应机理。"""
import argparse
import json
from pathlib import Path

import cantera as ct


def make_nonreactive(input_file, output_file):
    gas = ct.Solution(yaml=Path(input_file).read_text(encoding="utf-8-sig"))
    nonreactive = ct.Solution(
        name=gas.name,
        thermo=gas.thermo_model,
        kinetics=gas.kinetics_model,
        species=gas.species(),
        reactions=[],
        transport_model=gas.transport_model,
    )
    output = Path(output_file)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(nonreactive.write_yaml(precision=17), encoding="utf-8")
    return {"output_file": str(output), "species_count": nonreactive.n_species,
            "reaction_count": nonreactive.n_reactions}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", dest="input_file", required=True)
    parser.add_argument("--output", dest="output_file", required=True)
    result = make_nonreactive(**vars(parser.parse_args()))
    print(json.dumps(result))
