from shared.api import _inject_owner_token_bootstrap


def test_inject_owner_token_bootstrap_adds_meta_and_script_before_head_close():
    html = "<html><head><title>X</title></head><body>Hello</body></html>"
    token = 'owner-"quoted"-token'

    injected = _inject_owner_token_bootstrap(html, token)

    assert 'meta name="soundsible-owner-token"' in injected
    assert 'window.__SOUNDSIBLE_OWNER_TOKEN__=' in injected
    assert 'owner-\\"quoted\\"-token' in injected
    assert '&quot;' in injected
    assert injected.index('window.__SOUNDSIBLE_OWNER_TOKEN__') < injected.index('</head>')


def test_inject_owner_token_bootstrap_is_noop_without_token():
    html = "<html><head></head><body>Hello</body></html>"

    injected = _inject_owner_token_bootstrap(html, None)

    assert injected == html
