import {
  AiClassifyRequest,
  AiCompletionRequest,
  AiProvider,
  AiPurpose,
  AiResult,
  AiStructuredRequest,
} from '../ai-provider.interface';
import { AiProviderError } from '../ai-provider.error';

/**
 * `AI_PROVIDER=none`: kein Modell. Die Dienste fragen `isAvailable()`
 * und antworten 404 AI_DISABLED, bevor es bis hierher kommt.
 */
export class NoneProvider implements AiProvider {
  readonly name = 'none' as const;

  isAvailable(): boolean {
    return false;
  }

  supportsPdf(): boolean {
    return false;
  }

  modelFor(_purpose: AiPurpose): string {
    return 'none';
  }

  complete(_request: AiCompletionRequest): Promise<AiResult<string>> {
    return Promise.reject(this.disabled());
  }

  extractStructured<T>(_request: AiStructuredRequest): Promise<AiResult<T>> {
    return Promise.reject(this.disabled());
  }

  classify(_request: AiClassifyRequest): Promise<AiResult<string | null>> {
    return Promise.reject(this.disabled());
  }

  private disabled(): AiProviderError {
    return new AiProviderError('Kein Modellanbieter konfiguriert');
  }
}
