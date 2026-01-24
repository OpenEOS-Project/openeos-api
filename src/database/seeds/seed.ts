import { DataSource } from 'typeorm';
import * as bcrypt from 'bcrypt';
import { dataSourceOptions } from '../../config/data-source';
import { User } from '../entities/user.entity';
import { CreditPackage } from '../entities/credit-package.entity';

const BCRYPT_ROUNDS = 12;

async function seed() {
  const dataSource = new DataSource(dataSourceOptions);
  await dataSource.initialize();

  console.log('Starting seed...');

  try {
    // Seed Credit Packages
    const creditPackageRepository = dataSource.getRepository(CreditPackage);
    const existingPackages = await creditPackageRepository.count();

    if (existingPackages === 0) {
      console.log('Seeding credit packages...');

      const packages = [
        {
          name: 'Starter',
          slug: 'starter',
          credits: 50,
          price: 29.0,
          pricePerCredit: 0.58,
          savingsPercent: 0,
          description: 'Perfekt für kleine Veranstaltungen',
          isActive: true,
          sortOrder: 1,
        },
        {
          name: 'Standard',
          slug: 'standard',
          credits: 150,
          price: 79.0,
          pricePerCredit: 0.53,
          savingsPercent: 9,
          description: 'Für mittelgroße Events',
          isActive: true,
          isFeatured: true,
          sortOrder: 2,
        },
        {
          name: 'Premium',
          slug: 'premium',
          credits: 400,
          price: 199.0,
          pricePerCredit: 0.50,
          savingsPercent: 14,
          description: 'Ideal für große Veranstaltungen',
          isActive: true,
          sortOrder: 3,
        },
        {
          name: 'Enterprise',
          slug: 'enterprise',
          credits: 1000,
          price: 449.0,
          pricePerCredit: 0.45,
          savingsPercent: 22,
          description: 'Für Vereine mit vielen Events',
          isActive: true,
          sortOrder: 4,
        },
      ];

      for (const pkg of packages) {
        const creditPackage = creditPackageRepository.create(pkg);
        await creditPackageRepository.save(creditPackage);
        console.log(`  Created credit package: ${pkg.name}`);
      }
    } else {
      console.log('Credit packages already exist, skipping...');
    }

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
