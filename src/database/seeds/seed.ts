import { DataSource } from 'typeorm';
import * as bcrypt from 'bcrypt';
import { dataSourceOptions } from '../../config/data-source';
import { User } from '../entities/user.entity';

const BCRYPT_ROUNDS = 12;

async function seed() {
  const dataSource = new DataSource(dataSourceOptions);
  await dataSource.initialize();

  console.log('Starting seed...');

  try {
    // Seed Super Admin (if needed)
    const userRepository = dataSource.getRepository(User);
    const adminEmail = process.env.ADMIN_EMAIL || 'admin@openeos.local';
    const existingAdmin = await userRepository.findOne({
      where: { email: adminEmail },
    });

    if (!existingAdmin) {
      console.log('Creating super admin user...');

      const adminPassword = process.env.ADMIN_PASSWORD || 'Admin123!';
      const passwordHash = await bcrypt.hash(adminPassword, BCRYPT_ROUNDS);

      const admin = userRepository.create({
        email: adminEmail,
        passwordHash,
        firstName: 'Super',
        lastName: 'Admin',
        isSuperAdmin: true,
        isActive: true,
        emailVerifiedAt: new Date(),
      });

      await userRepository.save(admin);
      console.log(`  Created super admin: ${adminEmail}`);
      console.log(`  Password: ${adminPassword}`);
    } else {
      console.log('Super admin already exists, skipping...');
    }

    console.log('Seed completed successfully!');
  } catch (error) {
    console.error('Seed failed:', error);
    throw error;
  } finally {
    await dataSource.destroy();
  }
}

seed().catch((error) => {
  console.error(error);
  process.exit(1);
});
