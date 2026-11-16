/**
 * Fuer Unit-Tests: `repository.manager.transaction(fn)` ruft `fn` mit einem
 * Manager auf, dessen `getRepository(Entity)` die uebergebenen Mocks
 * liefert. So bleiben Erwartungen an `paymentRepository.save` & Co. gueltig,
 * auch wenn der Code innerhalb einer Transaktion bucht.
 */
export function transactionManager(
  repositories: ReadonlyArray<readonly [unknown, unknown]>,
): { transaction: (fn: (manager: unknown) => unknown) => Promise<unknown> } {
  const byEntity = new Map(repositories);
  const manager = {
    getRepository: (entity: unknown) => {
      const repository = byEntity.get(entity);
      if (!repository) {
        throw new Error('No repository mock for this entity');
      }
      return repository;
    },
  };
  return {
    transaction: (fn: (m: typeof manager) => unknown) =>
      Promise.resolve().then(() => fn(manager)),
  };
}
