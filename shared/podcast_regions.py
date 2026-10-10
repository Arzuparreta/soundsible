"""Apple podcast storefronts from its RSS builder (checked 2026-10-10).

Source: https://rss.marketingtools.apple.com/apple/podcasts/storefronts
A storefront selects a market, not a show's country of origin or language.
"""

PODCAST_COUNTRIES = frozenset(
    'af al dz ao ai ag ar am au at az bs bh bb by be bz bj bm bt bo ba bw br vg bn bg bf kh cm ca cv ky td cl cn co cr hr cy cz ci cd dk dm do ec eg sv ee sz fj fi fr ga gm ge de gh gr gd gt gw gy hn hk hu is in id iq ie il it jm jp jo kz ke kr xk kw kg la lv lb lr ly lt lu mo mg mw my mv ml mt mr mu mx fm md mn me ms ma mz mm na nr np nl nz ni ne ng mk no om pk pw pa pg py pe ph pl pt qa cg ro ru rw sa sn rs sc sl sg sk si sb za es lk kn lc vc sr se ch st tw tj tz th to tt tn tm tc tr ae ug ua gb us uy uz vu ve vn ye zm zw'.split()
)

def valid_podcast_country(value: object) -> bool:
    return isinstance(value, str) and value.strip().lower() in PODCAST_COUNTRIES
