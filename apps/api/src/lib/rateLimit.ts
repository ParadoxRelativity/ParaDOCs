import { HttpError } from './http.js';

/**
 * Counts events per key in fixed windows, in memory.
 *
 * Per-process, like the chat hub: the Docker image runs one process, and a
 * deployment with several would want these counts somewhere shared instead.
 */
export class RateLimiter {
  private readonly windows = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  /** Seconds until `key` may go again, or 0 when it may go now. */
  retryAfter(key: string): number {
    const entry = this.windows.get(key);
    if (!entry || entry.resetAt <= Date.now()) return 0;
    return entry.count >= this.limit ? Math.ceil((entry.resetAt - Date.now()) / 1000) : 0;
  }

  hit(key: string): void {
    const now = Date.now();
    const entry = this.windows.get(key);
    if (!entry || entry.resetAt <= now) {
      this.prune(now);
      this.windows.set(key, { count: 1, resetAt: now + this.windowMs });
    } else {
      entry.count++;
    }
  }

  reset(key: string): void {
    this.windows.delete(key);
  }

  /** Forgets finished windows once there are many, so a flood of keys cannot grow this forever. */
  private prune(now: number): void {
    if (this.windows.size < 10_000) return;
    for (const [key, entry] of this.windows) if (entry.resetAt <= now) this.windows.delete(key);
    if (this.windows.size >= 10_000) this.windows.clear();
  }
}

function tooMany(retryAfter: number, message: string): HttpError {
  return new HttpError(429, message, 'rate_limited', retryAfter);
}

const MINUTE = 60 * 1000;

/** Every sign-in attempt from one address, right or wrong. */
const attemptsByAddress = new RateLimiter(30, MINUTE);
/** Wrong passwords for one account, from anywhere. */
const failuresByAccount = new RateLimiter(10, 15 * MINUTE);
/** New accounts from one address. */
const registrationsByAddress = new RateLimiter(10, 60 * MINUTE);
/** Wrong current passwords when someone signed in changes theirs. */
const passwordChecksByUser = new RateLimiter(10, 15 * MINUTE);

/**
 * Guessing passwords, on the app's sign-in and the admin page's alike: they
 * check the same passwords, so they share the count. A limit on the account
 * stops guessing spread across many addresses; one on the address stops one
 * source trying many accounts.
 */
export const signInLimits = {
  check(address: string, email: string): void {
    const wait = Math.max(attemptsByAddress.retryAfter(address), failuresByAccount.retryAfter(email.toLowerCase()));
    if (wait) throw tooMany(wait, 'Too many sign-in attempts. Wait a few minutes and try again.');
    attemptsByAddress.hit(address);
  },
  failed(email: string): void {
    failuresByAccount.hit(email.toLowerCase());
  },
  succeeded(email: string): void {
    failuresByAccount.reset(email.toLowerCase());
  },
};

export const registrationLimits = {
  check(address: string): void {
    const wait = registrationsByAddress.retryAfter(address);
    if (wait) throw tooMany(wait, 'Too many accounts created from here. Try again later.');
    registrationsByAddress.hit(address);
  },
};

/** Someone with a session proving their password, as when they change it or their email. */
export const passwordCheckLimits = {
  check(userId: string): void {
    const wait = passwordChecksByUser.retryAfter(userId);
    if (wait) throw tooMany(wait, 'Too many wrong passwords. Wait a few minutes and try again.');
  },
  failed(userId: string): void {
    passwordChecksByUser.hit(userId);
  },
};
