"""Exercise the lab's real password-login UI without recording credentials."""
import argparse
import base64
import hashlib
import json
from pathlib import Path
import subprocess
import traceback
import uuid
from urllib.parse import urlsplit

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[2]
PRIVATE = ROOT / 'secrets/coder-lab'
OUTPUT = ROOT / 'artifacts/m1/t104/lab'


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--browser', required=True)
    args = parser.parse_args()
    state = json.loads((OUTPUT / 'state.json').read_text())
    account = json.loads((PRIVATE / 'account.json').read_text())
    run = OUTPUT / ('browser-' + uuid.uuid4().hex)
    run.mkdir(mode=0o700)
    public = subprocess.run(['openssl', 'x509', '-in', str(PRIVATE / 'tls/server.crt'), '-pubkey', '-noout'],
                            capture_output=True, check=True).stdout
    der = subprocess.run(['openssl', 'pkey', '-pubin', '-outform', 'DER'], input=public,
                         capture_output=True, check=True).stdout
    pin = base64.b64encode(hashlib.sha256(der).digest()).decode()
    canonical_url = 'https://coder:' + str(state['tlsPort'])
    errors = []
    blocked = []
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(executable_path=args.browser, headless=True,
                    args=['--ignore-certificate-errors-spki-list=' + pin, '--no-proxy-server',
                          '--host-resolver-rules=MAP coder ' + urlsplit(state['url']).netloc])
        context = browser.new_context()
        def restrict(route):
            if urlsplit(route.request.url).netloc != urlsplit(canonical_url).netloc:
                blocked.append(urlsplit(route.request.url).hostname)
                route.abort()
            else:
                route.continue_()
        context.route('**/*', restrict)
        page = context.new_page()
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.goto(canonical_url + '/login', wait_until='networkidle', timeout=45000)
        page.get_by_label('Email', exact=False).fill(account['email'])
        page.get_by_label('Password', exact=False).fill('intentionally-wrong-test-password')
        with page.expect_response(lambda response: urlsplit(response.url).path == '/api/v2/users/login') as failed_login:
            page.get_by_role('button', name='Sign In', exact=True).click()
        assert failed_login.value.status == 401
        assert urlsplit(page.url).path == '/login'
        page.get_by_label('Password', exact=False).fill(account['password'])
        with page.expect_response(lambda response: urlsplit(response.url).path == '/api/v2/users/login') as login:
            page.get_by_role('button', name='Sign In', exact=True).click()
        assert login.value.status == 201
        page.wait_for_url('**/workspaces*', timeout=30000)
        page.wait_for_load_state('networkidle')
        page.screenshot(path=str(run / 'workspace-before-check.png'), full_page=True)
        page.get_by_text('m1-a', exact=True).first.wait_for(timeout=30000)
        page.get_by_text('m1-b', exact=True).first.wait_for(timeout=30000)
        api = page.evaluate("""async () => {
          const response = await fetch('/api/v2/workspaces?q=owner%3Ame');
          const data = await response.json();
          return {status: response.status, names: data.workspaces.map(workspace => workspace.name)};
        }""")
        assert api['status'] == 200
        assert {'m1-a', 'm1-b'} <= set(api['names'])
        page.screenshot(path=str(run / 'workspace-dashboard.png'), full_page=True)
        report = {'task': 'T-104', 'stage': 'browser-login-to-workspaces', 'passed': not errors and not blocked,
                  'invalidPasswordStatus': failed_login.value.status, 'passwordLoginStatus': login.value.status,
                  'authenticatedWorkspaceApiStatus': api['status'], 'twoWorkspaceEntriesVisible': True,
                  'certificatePinUsed': True, 'privateHostnameMappedOnlyInTestBrowser': True,
                  'javascriptErrors': errors, 'blockedExternalHosts': blocked,
                  'credentialsCaptured': False, 'stageM1Passed': False}
        context.close()
        browser.close()
    print(json.dumps({'javascriptErrorCount': len(errors), 'blockedExternalHosts': blocked}))
    assert report['passed'], 'Browser page errors or attempted external requests'
    output = run / 'browser-login.json'
    with output.open('x') as handle:
        json.dump(report, handle, indent=2)
        handle.write('\n')
    assert json.loads(output.read_text()) == report
    print(json.dumps(report, indent=2))
    print('Evidence:', output.relative_to(ROOT))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        # Playwright request errors can contain session-cookie headers.
        line = traceback.extract_tb(error.__traceback__)[-1].lineno
        print(f'FAIL: browser verification raised {type(error).__name__} at line {line}; request details withheld')
        raise SystemExit(1) from None
