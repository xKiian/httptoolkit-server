import _ from 'lodash';

import { Interceptor } from "..";
import { HtkConfig } from '../../config';

import { createAdbClient } from '../android/adb-commands';
import {
    FridaHost,
    FridaTarget,
    getAndroidFridaHosts,
    getAndroidFridaTargets,
    interceptAndroidFridaTarget,
    launchAndroidHost,
    setupAndroidHost
} from './frida-hosts';

export class FridaAndroidInterceptor implements Interceptor {

    id: string = "android-frida";
    version: string = "1.0.0";

    private adbClient = createAdbClient();

    constructor(
        private config: HtkConfig
    ) {}

    private _fridaTargetsPromise: Promise<Array<FridaHost>> | undefined;
    async getFridaHosts(): Promise<Array<FridaHost>> {
        if (!this._fridaTargetsPromise) {
            // We cache the targets lookup whilst it's active, so that concurrent calls
            // all just run one lookup and return the same result.
            this._fridaTargetsPromise = getAndroidFridaHosts(this.adbClient)
                .finally(() => { this._fridaTargetsPromise = undefined; });
        }
        return await this._fridaTargetsPromise;
    }

    async isActivable(): Promise<boolean> {
        return (await this.getFridaHosts()).length > 0;
    }

    activableTimeout = 3000; // Increase timeout for device detection slightly

    isActive(): boolean {
        // TODO: track active interceptions
        return false;
    }

    async getMetadata(type: 'summary' | 'detailed') {
        // TODO: Do we want to use type here? Maybe to speed up/simplify host search?
        const fridaHosts = await this.getFridaHosts();
        return {
            hosts: fridaHosts
        };
    }

    async getSubMetadata(hostId: string): Promise<{ targets: Array<FridaTarget> }> {
        // TODO: Think about 404 errors if host no longer present
        return {
            targets: await getAndroidFridaTargets(this.adbClient, hostId)
            // TODO: Attach is-active metadata for intercepted items
        }
    }

    async activate(
        proxyPort: number,
        options:
            | { action: 'setup', hostId: string }
            | { action: 'launch', hostId: string }
            | { action: 'intercept', hostId: string, targetId: string }
    ): Promise<void> {
        // TODO: Think about checking Frida state & races here
        if (options.action === 'setup') {
            await setupAndroidHost(this.adbClient, options.hostId);
        } else if (options.action === 'launch') {
            await launchAndroidHost(this.adbClient, options.hostId);
        } else if (options.action === 'intercept') {
            await interceptAndroidFridaTarget(
                this.adbClient,
                options.hostId,
                options.targetId,
                this.config.https.certContent,
                proxyPort
            );
        } else {
            throw new Error(`Unknown Frida interception command: ${(options as any).action ?? '(none)'}`)
        }
    }

    async deactivate(proxyPort: number): Promise<void | {}> {
        // TODO: Stop intercepted apps
        // TODO: Stop Frida server!
    }

    async deactivateAll(): Promise<void | {}> {
    }

}