"""Browser E2E (needs: pip install playwright + chromium). Run: python3 test/e2e.py"""
import subprocess, os, time, tempfile, sys
from playwright.sync_api import sync_playwright
PORT = 3777; BASE = f'http://127.0.0.1:{PORT}'; errs = []; results = []
env = {**os.environ, 'PORT': str(PORT), 'DATA_DIR': tempfile.mkdtemp(), 'DEV_OTP': '1', 'AUTH_RATE': '1000', 'SEND_RATE': '1000'}
srv = subprocess.Popen(['node', 'server.js'], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL); time.sleep(1.5)
def check(name, cond):
    results.append((name, bool(cond))); print(('PASS ' if cond else 'FAIL ') + name)
def onboard(page, num, name):
    page.on('pageerror', lambda e: errs.append(str(e)))
    page.goto(BASE); page.fill('#phoneInput', num); page.click('#screen-phone .onb-btn')
    page.wait_for_selector('#otpBanner:has-text("OTP is")'); otp = page.inner_text('#otpBanner').split()[-1]
    for i, ch in enumerate(otp): page.locator('.otp-box').nth(i).fill(ch)
    page.click('#screen-otp .onb-btn'); page.fill('#nameInput', name); page.click('#screen-profile-setup .onb-btn')
    page.wait_for_selector('#app-shell:not([hidden])')
def send(page, text):
    page.fill('#msgInput', text); page.click('.mic-send')
def last_tick(page): return page.locator('.bubble.out .tick').last.inner_text()
try:
    with sync_playwright() as p:
        br = p.chromium.launch(); mk = lambda: br.new_context(viewport={'width': 390, 'height': 800})
        ca, cb = mk(), mk(); a, b = ca.new_page(), cb.new_page()
        onboard(b, '9111111112', 'Bob'); onboard(a, '9111111111', 'Alice')
        answers = ['9111111112', '']; a.on('dialog', lambda d: d.accept(answers.pop(0)) if d.type == 'prompt' else d.accept())
        a.click('#view-chats .header-icons .icon-btn:last-child'); a.wait_for_selector('#view-conversation.active')
        check('A creates 1:1 chat with B and opens it', a.inner_text('#convName') == 'Bob')
        send(a, 'hello from A'); a.wait_for_selector('.bubble.out:has-text("hello from A")')
        b.wait_for_selector('.chat-item'); b.click('.chat-item'); b.wait_for_selector('.bubble.in:has-text("hello from A")')
        check('B receives A message in realtime', True)
        for _ in range(40):
            if last_tick(a).count('✓') == 2: break
            time.sleep(0.25)
        check('A sees read ticks after B opened the chat', 'ge' not in last_tick(a) and last_tick(a).count('✓') == 2)
        send(b, 'reply from B'); a.wait_for_selector('.bubble.in:has-text("reply from B")')
        check('A receives B reply', True)
        ca.set_offline(True); send(a, 'sent offline'); time.sleep(0.5)
        check('offline message shows pending clock, not a fake tick', '🕓' in last_tick(a))
        ca.set_offline(False); b.wait_for_selector('.bubble.in:has-text("sent offline")', timeout=20000)
        check('queued message auto-sent after reconnect (backoff retry)', True)
        a.route('**/api/conversations/*/messages', lambda r: r.abort() if r.request.method == 'POST' else r.continue_())
        send(a, 'survives restart'); time.sleep(0.5)
        a.reload(); a.wait_for_selector('#app-shell:not([hidden])'); a.wait_for_selector('.chat-item'); a.click('.chat-item')
        a.wait_for_selector('.bubble.out:has-text("survives restart")')
        check('after reload: still logged in, history loaded, pending message preserved', '🕓' in last_tick(a))
        a.unroute('**/api/conversations/*/messages')
        b.wait_for_selector('.bubble.in:has-text("survives restart")', timeout=25000)
        check('preserved pending message delivered exactly once after restart', b.locator('.bubble.in:has-text("survives restart")').count() == 1)
        a.screenshot(path='/tmp/a_chat.png')
        check('no JS page errors', not errs)
        br.close()
finally:
    srv.terminate()
print('\n%d/%d passed' % (sum(r[1] for r in results), len(results))); sys.exit(0 if all(r[1] for r in results) else 1)
