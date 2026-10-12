import { expect, type Page, type TestInfo } from '@playwright/test';
import { createPhoneLoginRecovery, assertExpectedLoginUser } from '../scripts/phone-login-recovery.mjs';
import { capturedSessionDeadline } from './sessionBootstrapRecovery';

export { assertExpectedLoginUser };
const operations = new WeakMap<Page, ReturnType<typeof createPhoneLoginRecovery>>();
const sequences = new WeakMap<TestInfo, number>();
const password = 'Synthetic-Browser-Only-2026';

export async function uiPhoneLogin(page: Page, info: TestInfo, phone: string, expectedUserId: string) {
  const deadline = capturedSessionDeadline(page, info);
  let operation = operations.get(page);
  if (!operation) { operation = createPhoneLoginRecovery({ page, deadline }); operations.set(page, operation); }
  const sequence = (sequences.get(info) ?? 0) + 1; sequences.set(info, sequence);
  await operation({ phone, password, expectedUserId,
    prepare: async (budget: () => number) => {
      await page.getByPlaceholder('请输入手机号', { exact: true }).fill(phone, { timeout: budget() });
      await page.getByPlaceholder('请输入密码', { exact: true }).fill(password, { timeout: budget() });
      const form = await page.locator('form').filter({ has: page.getByPlaceholder('请输入手机号', { exact: true }) }).elementHandle({ timeout: budget() });
      if (!form) throw new Error('Missing original phone login form');
      const control = await form.$('button[type="submit"]');
      if (!control) { await form.dispose(); throw new Error('Missing original phone login submit control'); }
      const guard = await form.evaluateHandle((element, intent) => {
        const phoneInput = element.querySelector<HTMLInputElement>('input[placeholder="请输入手机号"]');
        const passwordInput = element.querySelector<HTMLInputElement>('input[placeholder="请输入密码"]');
        const submit = element.querySelector<HTMLButtonElement>('button[type="submit"]');
        let changed = false, armed = false, submissions = 0;
        const markChanged = () => { changed = true; };
        element.addEventListener('input', markChanged, true); element.addEventListener('change', markChanged, true);
        const read = () => ({
            submissions,
            unchanged: !changed && element.isConnected && phoneInput === element.querySelector('input[placeholder="请输入手机号"]') && passwordInput === element.querySelector('input[placeholder="请输入密码"]') && submit === element.querySelector('button[type="submit"]') && phoneInput?.value === intent.phone && passwordInput?.value === intent.password,
            visible: !!phoneInput?.getClientRects().length && !!passwordInput?.getClientRects().length && !!submit?.getClientRects().length,
            enabled: !!submit && !submit.disabled,
            rateLimited: element.textContent?.includes('请求过于频繁') === true,
        });
        // Close the browser scheduling gap between the final read and native
        // click: a changed/replaced form must never dispatch another POST.
        const guardSubmit = (event: Event) => {
          if (!armed || !read().unchanged) { changed = true; event.preventDefault(); event.stopImmediatePropagation(); }
          else submissions++;
          armed = false;
        };
        element.addEventListener('submit', guardSubmit, true);
        return { read, arm: () => { const state = read(); if (!state.unchanged || !state.visible || !state.enabled) throw new Error('Original phone login form changed before click'); armed = true; },
          dispose: () => { element.removeEventListener('input', markChanged, true); element.removeEventListener('change', markChanged, true); element.removeEventListener('submit', guardSubmit, true); },
        };
      }, { phone, password });
      let submitted = 0;
      return {
        read: () => guard.evaluate(value => value.read()),
        click: async (_timeout: number, beginClick: () => number, assertCurrent: () => number) => {
          await guard.evaluate(value => value.arm());
          const timeout = beginClick();
          await control.click({ timeout });
          const state = await guard.evaluate(value => value.read()); assertCurrent();
          if (state.submissions !== ++submitted) throw new Error('Click did not submit its original phone login form');
        },
        dispose: async () => { try { await guard.evaluate(value => value.dispose()); } finally { await guard.dispose(); await control.dispose(); await form.dispose(); } },
      };
    },
    poll: async (read: () => Promise<boolean> | boolean, timeout: number) => { await expect.poll(read, { timeout }).toBe(true); },
    capture: async (state: { phase: string }) => {
      const name = `phone-login-${sequence}-${state.phase}`;
      // IDs/statuses only: no phone, password, cookie, token, or response body.
      await info.attach(`${name}.json`, { body: JSON.stringify(state), contentType: 'application/json' });
      await page.screenshot({ path: info.outputPath(`${name}.png`), fullPage: true, animations: 'disabled', timeout: Math.max(1, Math.min(5000, deadline - Date.now() - 5000)), mask: [page.getByPlaceholder('请输入手机号', { exact: true }), page.getByPlaceholder('请输入密码', { exact: true })] });
    },
    workspace: (timeout: number) => expect(page.getByTestId('workspace')).toBeVisible({ timeout }),
  });
}
