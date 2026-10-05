import { Injectable, BadRequestException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { v4 as uuidv4 } from 'uuid';
import * as path from 'path';
import * as fs from 'fs/promises';
import { UploadCategory } from './dto';
import { ErrorCodes, ErrorReasons } from '../../common/constants/error-codes';

const OWNER_ID = /^[A-Za-z0-9-]{1,64}$/;

/** Verzeichnisse, die ein Upload anlegen darf: die Kategorien plus 'general'. */
const UPLOAD_DIRECTORIES = new Set<string>([
  ...Object.values(UploadCategory),
  'general',
]);

const EXTENSION_FOR_MIME: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
};

/**
 * So sehen gespeicherte Dateinamen aus: eine UUID mit kurzer Endung. Die
 * Endung ist bewusst locker, weil aeltere Uploads sie noch aus dem
 * Original-Dateinamen uebernommen haben — Pfadtrenner und `..` sind durch
 * das Muster trotzdem ausgeschlossen.
 */
const STORED_FILENAME =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[a-z0-9]{1,10}$/i;

export interface UploadedFile {
  id: string;
  originalName: string;
  filename: string;
  mimetype: string;
  size: number;
  url: string;
  category?: UploadCategory;
}

export interface MulterFile {
  fieldname: string;
  originalname: string;
  encoding: string;
  mimetype: string;
  size: number;
  buffer: Buffer;
}

@Injectable()
export class UploadsService {
  private readonly logger = new Logger(UploadsService.name);
  private readonly uploadDir: string;
  private readonly maxFileSize = 5 * 1024 * 1024; // 5MB
  private readonly allowedMimeTypes = [
    'image/jpeg',
    'image/png',
    'image/webp',
    'image/gif',
  ];

  constructor(private readonly configService: ConfigService) {
    this.uploadDir =
      this.configService.get<string>('UPLOAD_DIR') || './uploads';
  }

  async uploadImage(
    file: MulterFile,
    organizationId: string,
    category?: UploadCategory,
  ): Promise<UploadedFile> {
    // Validate file
    this.validateFile(file);

    /* Die Kategorie kommt als Query-Parameter. Ein TypeScript-Enum am
       Parameter prueft zur Laufzeit nichts — ohne diese Pruefung landete
       `../<andere-id>/…` unveraendert im Pfad. */
    const categoryDir = this.categoryOrThrow(category);

    /* Endung aus dem geprueften MIME-Typ, nicht aus dem vom Client
       gelieferten Dateinamen: der kann `.js` oder `.html` heissen, obwohl
       der Inhalt als Bild durchgewunken wurde. */
    const fileId = uuidv4();
    const filename = `${fileId}${EXTENSION_FOR_MIME[file.mimetype]}`;

    const uploadPath = this.pathInside(organizationId, categoryDir);
    if (!uploadPath) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        reason: ErrorReasons.UPLOAD_INVALID_PATH,
        message: 'Ungültiger Speicherort',
      });
    }
    await this.ensureDirectory(uploadPath);

    const filePath = path.join(uploadPath, filename);
    await fs.writeFile(filePath, file.buffer);

    // Generate URL — keep this relative so the frontend can prepend the API base
    // (NEXT_PUBLIC_API_URL) at render time. APP_URL is the frontend URL in our setup.
    const url = `/uploads/${organizationId}/${categoryDir}/${filename}`;

    this.logger.log(`File uploaded: ${filename} for org ${organizationId}`);

    return {
      id: fileId,
      originalName: file.originalname,
      filename,
      mimetype: file.mimetype,
      size: file.size,
      url,
      category,
    };
  }

  async deleteImage(
    organizationId: string,
    filename: string,
    category?: UploadCategory,
  ): Promise<void> {
    /* Wirft bewusst nicht: der Avatar-Tausch ruft das mit dem Dateinamen
       aus einer alten URL auf, die alles Moegliche sein kann. Ein
       ungueltiger Name heisst hier nur: es gibt nichts zu loeschen. */
    const filePath = this.filePathInside(organizationId, category, filename);
    if (!filePath) {
      this.logger.warn(
        `Refused to delete outside the upload area: ${filename}`,
      );
      return;
    }

    try {
      await fs.access(filePath);
      await fs.unlink(filePath);
      this.logger.log(`File deleted: ${filename}`);
    } catch {
      this.logger.warn(`File not found for deletion: ${filename}`);
    }
  }

  async getImagePath(
    organizationId: string,
    filename: string,
    category?: string,
  ): Promise<string | null> {
    const filePath = this.filePathInside(organizationId, category, filename);
    if (!filePath) return null;

    try {
      await fs.access(filePath);
      return filePath;
    } catch {
      return null;
    }
  }

  private categoryOrThrow(category?: string): string {
    const dir = category || 'general';
    if (!UPLOAD_DIRECTORIES.has(dir)) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        reason: ErrorReasons.UPLOAD_INVALID_CATEGORY,
        message: 'Ungültige Kategorie',
      });
    }
    return dir;
  }

  /**
   * Pfad zu einer gespeicherten Datei — oder null, wenn Kategorie oder
   * Dateiname nicht dem entsprechen, was `uploadImage` selbst anlegt.
   */
  private filePathInside(
    ownerId: string,
    category: string | undefined,
    filename: string,
  ): string | null {
    const dir = category || 'general';
    if (!UPLOAD_DIRECTORIES.has(dir)) return null;
    if (!STORED_FILENAME.test(filename)) return null;

    const folder = this.pathInside(ownerId, dir);
    return folder ? path.join(folder, filename) : null;
  }

  /**
   * Verzeichnis `<UPLOAD_DIR>/<ownerId>/<dir>` — nur wenn es tatsaechlich
   * unterhalb des Bereichs dieses Eigentuemers liegt.
   *
   * Die Pruefungen oben lassen schon keine Pfadtrenner durch; das hier ist
   * die zweite Linie, die auch dann haelt, wenn spaeter jemand eine
   * Kategorie oder einen Aufrufer ergaenzt.
   */
  private pathInside(ownerId: string, dir: string): string | null {
    /* Die Eigentuemer-ID ist eine UUID (Organisation oder Benutzer). Nur
       die Ebene zu pruefen genuegt nicht: `<eigene>/../<fremde>` loest sich
       zu genau einem Verzeichnis auf — dem fremden. */
    if (!OWNER_ID.test(ownerId)) return null;

    const ownerRoot = path.resolve(this.uploadDir, ownerId);

    const target = path.resolve(ownerRoot, dir);
    return target.startsWith(ownerRoot + path.sep) ? target : null;
  }

  private validateFile(file: MulterFile): void {
    if (!file) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        reason: ErrorReasons.UPLOAD_FILE_MISSING,
        message: 'Keine Datei hochgeladen',
      });
    }

    if (file.size > this.maxFileSize) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        reason: ErrorReasons.UPLOAD_FILE_TOO_LARGE,
        message: `Datei zu groß. Maximal ${this.maxFileSize / 1024 / 1024}MB erlaubt`,
        params: { maxMb: this.maxFileSize / 1024 / 1024 },
      });
    }

    if (!this.allowedMimeTypes.includes(file.mimetype)) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        reason: ErrorReasons.UPLOAD_FILE_TYPE_INVALID,
        message: `Ungültiger Dateityp. Erlaubt: ${this.allowedMimeTypes.join(', ')}`,
        params: { allowed: this.allowedMimeTypes.join(', ') },
      });
    }
  }

  private async ensureDirectory(dir: string): Promise<void> {
    try {
      await fs.access(dir);
    } catch {
      await fs.mkdir(dir, { recursive: true });
    }
  }
}
