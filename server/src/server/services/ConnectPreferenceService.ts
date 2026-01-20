export type ConnectType = 'wifi' | 'usb';

export class ConnectPreferenceService {
    private static instance?: ConnectPreferenceService;
    private readonly preferences: Map<string, ConnectType> = new Map();

    private constructor() {
        // singleton
    }

    public static getInstance(): ConnectPreferenceService {
        if (!this.instance) {
            this.instance = new ConnectPreferenceService();
        }
        return this.instance;
    }

    public setPreference(uuid: string, connect: ConnectType): void {
        if (!uuid) {
            return;
        }
        this.preferences.set(uuid, connect);
    }

    public getPreference(uuid: string): ConnectType | undefined {
        return this.preferences.get(uuid);
    }
}
