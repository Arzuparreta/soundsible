from shared.api import app


# Regression: ISSUE-001 - player pages emitted an invalid Permissions-Policy header
# Found by /qa on 2026-05-18
# Report: .gstack/qa-reports/qa-report-localhost-5005-2026-05-18.md
def test_player_pages_do_not_emit_invalid_permissions_policy_header():
    client = app.test_client()

    web_res = client.get("/player/")
    desktop_res = client.get("/player/desktop/")

    assert "Permissions-Policy" not in web_res.headers
    assert "Permissions-Policy" not in desktop_res.headers
