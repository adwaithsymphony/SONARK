"""Arithmetic in the finite field GF(2^8).

Elements are bytes 0..255. Addition is XOR. Multiplication is polynomial
multiplication modulo the primitive polynomial x^8 + x^4 + x^3 + x^2 + 1
(0x11D), done through log/exp tables.
"""

PRIMITIVE_POLY = 0x11D

EXP = [0] * 512
LOG = [0] * 256

_x = 1
for _i in range(255):
    EXP[_i] = _x
    LOG[_x] = _i
    _x <<= 1
    if _x & 0x100:
        _x ^= PRIMITIVE_POLY
for _i in range(255, 512):
    EXP[_i] = EXP[_i - 255]
del _x, _i


def mul(a: int, b: int) -> int:
    if a == 0 or b == 0:
        return 0
    return EXP[LOG[a] + LOG[b]]


def div(a: int, b: int) -> int:
    if b == 0:
        raise ZeroDivisionError("division by zero in GF(256)")
    if a == 0:
        return 0
    return EXP[(LOG[a] - LOG[b]) % 255]


def inv(a: int) -> int:
    return div(1, a)


# MUL_TABLES[c] is a 256-byte translation table mapping x -> c*x.
# bytes.translate(MUL_TABLES[c]) multiplies a whole buffer by c in C speed.
MUL_TABLES = [bytes(mul(c, x) for x in range(256)) for c in range(256)]


def mat_inv(matrix: list[list[int]]) -> list[list[int]]:
    """Invert a square matrix over GF(256) with Gauss-Jordan elimination."""
    n = len(matrix)
    aug = [list(row) + [1 if i == j else 0 for j in range(n)] for i, row in enumerate(matrix)]
    for col in range(n):
        pivot = next((r for r in range(col, n) if aug[r][col]), None)
        if pivot is None:
            raise ValueError("matrix is singular")
        aug[col], aug[pivot] = aug[pivot], aug[col]
        p_inv = inv(aug[col][col])
        aug[col] = [mul(v, p_inv) for v in aug[col]]
        for r in range(n):
            if r != col and aug[r][col]:
                f = aug[r][col]
                aug[r] = [a ^ mul(f, b) for a, b in zip(aug[r], aug[col])]
    return [row[n:] for row in aug]


def mat_mul(a: list[list[int]], b: list[list[int]]) -> list[list[int]]:
    cols = len(b[0])
    out = []
    for row in a:
        out_row = []
        for c in range(cols):
            acc = 0
            for k, v in enumerate(row):
                acc ^= mul(v, b[k][c])
            out_row.append(acc)
        out.append(out_row)
    return out
