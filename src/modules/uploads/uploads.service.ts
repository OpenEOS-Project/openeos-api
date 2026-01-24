import {
  Injectable,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { v4 as uuidv4 } from 'uuid';
import * as path from 'path';
import * as fs from 'fs/promises';
import { UploadCategory } from './dto';
import { ErrorCodes } from '../../common/constants/error-codes';

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
    this.uploadDir = this.configService.get<string>('UPLOAD_DIR') || './uploads';
  }

  async uploadImage(
    file: MulterFile,
    organizationId: string,
    category?: UploadCategory,
  ): Promise<UploadedFile> {
    // Validate file
    this.validateFile(file);

    // Generate unique filename
    const fileId = uuidv4();
    const ext = path.extname(file.originalname).toLowerCase() || '.jpg';
    const filename = `${fileId}${ext}`;

    // Create directory structure
    const categoryDir = category || 'general';
    const uploadPath = path.join(this.uploadDir, organizationId, categoryDir);
    await this.ensureDirectory(uploadPath);

    // Save file
    const filePath = path.join(uploadPath, filename);
    await fs.writeFile(filePath, file.buffer);

    // Generate URL
    const baseUrl = this.configService.get<string>('APP_URL') || '';
    const url = `${baseUrl}/uploads/${organizationId}/${categoryDir}/${filename}`;

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
    const categoryDir = category || 'general';
    const filePath = path.join(this.uploadDir, organizationId, categoryDir, filename);

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
    const categoryDir = category || 'general';
    const filePath = path.join(this.uploadDir, organizationId, categoryDir, filename);

    try {
      await fs.access(filePath);
      return filePath;
    } catch {
      return null;
    }
  }

  private validateFile(file: MulterFile): void {
    if (!file) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        message: 'Keine Datei hochgeladen',
      });
    }

    if (file.size > this.maxFileSize) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        message: `Datei zu groß. Maximal ${this.maxFileSize / 1024 / 1024}MB erlaubt`,
      });
    }

    if (!this.allowedMimeTypes.includes(file.mimetype)) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        message: `Ungültiger Dateityp. Erlaubt: ${this.allowedMimeTypes.join(', ')}`,
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
