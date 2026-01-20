import fs from 'fs';
import path from 'path';
import { ActionRecorder, RecordingFile } from './ActionRecorder';

export type ListedRecording = {
    id: string;
    name?: string;
    createdAt: string;
    remote?: string;
    label: string;
};

export class RecordingRepository {
    private static readonly ROOT_DIR = path.resolve(process.cwd(), 'recordings');

    public static async list(): Promise<ListedRecording[]> {
        const files = await this.listFiles();
        const records: ListedRecording[] = [];
        for (const file of files) {
            try {
                const content = await fs.promises.readFile(file, 'utf8');
                const parsed: RecordingFile = JSON.parse(content);
                const id = parsed.id || path.basename(file, '.json');
                const name = parsed.name || (parsed.meta as any)?.name;
                const createdAt = parsed.createdAt || (await fs.promises.stat(file)).mtime.toISOString();
                const remote = parsed.remote;
                const label = `${createdAt}-${name || id}-false`;
                records.push({ id, name, createdAt, remote, label });
            } catch {
                // skip broken files
            }
        }
        return records.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    }

    public static async updateName(recordId: string, name: string): Promise<void> {
        const filePath = this.resolvePath(recordId);
        const content = await fs.promises.readFile(filePath, 'utf8');
        const parsed: RecordingFile = JSON.parse(content);
        parsed.name = name;
        await fs.promises.writeFile(filePath, JSON.stringify(parsed, null, 2), 'utf8');
    }

    public static async delete(recordId: string): Promise<void> {
        const filePath = this.resolvePath(recordId);
        await fs.promises.unlink(filePath);
    }

    private static resolvePath(recordId: string): string {
        const safeId = ActionRecorder.normalizeId(recordId);
        if (!safeId) {
            throw new Error('Invalid recordId');
        }
        const filePath = path.join(this.ROOT_DIR, `${safeId}.json`);
        if (!fs.existsSync(filePath)) {
            throw new Error('Recording not found');
        }
        return filePath;
    }

    private static async listFiles(): Promise<string[]> {
        try {
            const entries = await fs.promises.readdir(this.ROOT_DIR);
            return entries.filter((f) => f.endsWith('.json')).map((f) => path.join(this.ROOT_DIR, f));
        } catch (err: any) {
            if (err?.code === 'ENOENT') {
                return [];
            }
            throw err;
        }
    }
}
