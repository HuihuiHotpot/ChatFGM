"""Ember 原生 Q 稳态判据。"""

import numpy as np


def Q_is_steady(
    time,
    Q,
    t_now,
    steady_period=0.002,
    tolerance=1e-2,
    abstol=0.5,
):
    indices = np.flatnonzero(
        np.asarray(time) < t_now - steady_period
    )
    if indices.size == 0:
        return False, None, None

    Q = np.asarray(Q)[indices[-1]:]
    Q_mean = np.mean(Q)
    # 原生Q判据，相当于RMS/sqrt(N)
    # error = np.sqrt(np.sum((Q - Q_mean) ** 2)) / Q.size

    # 标准RMS
    error = np.sqrt(np.mean((Q - Q_mean) ** 2))

    relative_error =  error / abs(Q_mean)

    steady = (
        relative_error < tolerance
        or error < abstol
    )

    return steady, error, relative_error