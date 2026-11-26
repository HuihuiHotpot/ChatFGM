"""用 Ember 原生 multirun 完成一个着火 case 的应变率延拓。"""
import math
from pathlib import Path

from ember import *

def run_case(
    mechanism_file,
    restart_file,
    output_dir,
    fuel,
    oxidizer,
    Tfuel,
    Toxidizer,
    pressure,
    strain_rates,
    dt=5e-8,
    n_threads=16,
):

    output_dir = Path(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    conf = Config(
        Paths(outputDir=str(output_dir)),
        Chemistry(
            mechanismFile=str(mechanism_file),
            transportModel="UnityLewis",
            kineticsModel="standard",
        ),
        InitialCondition(
            restartFile=str(restart_file),
            flameType="diffusion",
            fuel=fuel,
            oxidizer=oxidizer,
            Tfuel=Tfuel,
            Toxidizer=Toxidizer,
            pressure=pressure,
        ),
        # 每个应变率的计算及剖面传递由 multirun 完成。
        StrainParameters(rates=strain_rates),
        General(
            nThreads=n_threads,
            chemistryIntegrator="cvode"
        ),
        Times(
            tStart=0.0,
            globalTimestep=dt,
            currentStateStepInterval=math.ceil(10.0 / dt) + 1,
        ),
        TerminationCondition(
            tEnd=10.0,
            measurement="Q",
        ),
        OutputFiles(
            fileExtension="h5",
            saveProfiles=False,
            extraVariables=True,
        ),
        Debug(
            timesteps=False,
            regridding=False
        ),
    )
    conf.run()