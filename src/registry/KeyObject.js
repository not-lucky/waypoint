const GENERIC_FAILURE_COOLDOWN_MS = 5000;

export class KeyObject {
  constructor(keyStr) {
    this.keyStr = keyStr;
    this.active = true;
    this.cooldownUntil = null;
    this.consecutiveFailures = 0;
    this.exhausted = false;
  }

  isAvailable() {
    const cooledDown = this.cooldownUntil === null || this.cooldownUntil <= Date.now();
    return this.active && !this.exhausted && cooledDown;
  }
}

export { GENERIC_FAILURE_COOLDOWN_MS };
