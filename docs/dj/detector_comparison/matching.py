"""Ordered maximum matching with minimum total timing error; NumPy only."""
from __future__ import annotations


def ordered_matches(delta, inside):
    n, m = delta.shape
    scale = max(n+m, 1)
    # A matched edge costs less than 1/scale; skipping an event costs 1.
    # Thus cardinality dominates timing for the entire assignment.
    previous = [float(j) for j in range(m+1)]
    trace = [bytearray(m+1) for _ in range(n+1)]
    for i in range(1, n+1):
        current = [float(i)]+[0.]*m
        for j in range(1, m+1):
            diagonal = previous[j-1]+abs(float(delta[i-1, j-1]))/scale if inside[i-1, j-1] else float('inf')
            up, left = previous[j]+1, current[j-1]+1
            if diagonal <= up and diagonal <= left:
                current[j], trace[i][j] = diagonal, 1
            elif up <= left:
                current[j], trace[i][j] = up, 2
            else:
                current[j], trace[i][j] = left, 3
        previous = current
    matched = []
    i, j = n, m
    while i and j:
        if trace[i][j] == 1:
            matched.append((i-1, j-1))
            i, j = i-1, j-1
        elif trace[i][j] == 2:
            i -= 1
        else:
            j -= 1
    return matched[::-1]
