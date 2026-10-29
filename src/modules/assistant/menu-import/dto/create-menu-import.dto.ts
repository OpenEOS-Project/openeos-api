import { IsOptional, IsString, MaxLength } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Textfeld des multipart-Bodys. Die Dateien (`files[]`) kommen ueber
 * multer, nicht ueber den Body — hier bewusst nicht deklariert: Mit
 * `useDefineForClassFields` waere ein undeklariertes Feld eine eigene
 * Eigenschaft `undefined`, die `forbidNonWhitelisted` abweist. Die
 * Swagger-Beschreibung des Uploads steht am Endpunkt (`@ApiBody`).
 */
export class CreateMenuImportDto {
  @ApiPropertyOptional({
    description:
      'Alternativ zum Upload: die Speisekarte als Text (max. 20.000 Zeichen)',
  })
  @IsOptional()
  @IsString()
  @MaxLength(20000)
  text?: string;
}
