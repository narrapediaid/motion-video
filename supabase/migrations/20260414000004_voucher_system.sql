-- Voucher system schema + baseline seed
-- Depends on: 20260414000001_membership_core.sql

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_type t
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = 'public' AND t.typname = 'voucher_discount_type'
  ) THEN
    CREATE TYPE public.voucher_discount_type AS ENUM ('percentage', 'fixed_amount');
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_type t
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = 'public' AND t.typname = 'voucher_redemption_status'
  ) THEN
    CREATE TYPE public.voucher_redemption_status AS ENUM ('reserved', 'applied', 'released', 'canceled');
  END IF;
END;
$$;

CREATE TABLE IF NOT EXISTS public.vouchers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text UNIQUE NOT NULL,
  name text NOT NULL,
  description text,
  discount_type public.voucher_discount_type NOT NULL,
  discount_value numeric(12,2) NOT NULL CHECK (discount_value > 0),
  max_discount_idr bigint CHECK (max_discount_idr >= 0),
  min_purchase_idr bigint NOT NULL DEFAULT 0 CHECK (min_purchase_idr >= 0),
  max_redemptions integer CHECK (max_redemptions > 0),
  per_user_limit integer NOT NULL DEFAULT 1 CHECK (per_user_limit > 0),
  starts_at timestamptz,
  ends_at timestamptz,
  is_active boolean NOT NULL DEFAULT true,
  allowed_tiers public.membership_tier[] NOT NULL DEFAULT '{}'::public.membership_tier[],
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (code = upper(code)),
  CHECK (ends_at IS NULL OR starts_at IS NULL OR ends_at > starts_at),
  CHECK (
    (discount_type = 'percentage' AND discount_value <= 100)
    OR discount_type = 'fixed_amount'
  )
);

CREATE TABLE IF NOT EXISTS public.voucher_redemptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  voucher_id uuid NOT NULL REFERENCES public.vouchers(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  invoice_id uuid REFERENCES public.invoices(id) ON DELETE SET NULL,
  order_id text,
  voucher_code text NOT NULL,
  status public.voucher_redemption_status NOT NULL DEFAULT 'reserved',
  base_amount_idr bigint NOT NULL CHECK (base_amount_idr >= 0),
  discount_idr bigint NOT NULL CHECK (discount_idr >= 0),
  final_amount_idr bigint NOT NULL CHECK (final_amount_idr >= 0),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (voucher_code = upper(voucher_code)),
  CHECK (final_amount_idr = base_amount_idr - discount_idr)
);

CREATE INDEX IF NOT EXISTS idx_vouchers_code_active ON public.vouchers(code, is_active);
CREATE INDEX IF NOT EXISTS idx_vouchers_schedule ON public.vouchers(starts_at, ends_at);
CREATE INDEX IF NOT EXISTS idx_voucher_redemptions_voucher_status ON public.voucher_redemptions(voucher_id, status);
CREATE INDEX IF NOT EXISTS idx_voucher_redemptions_user_status ON public.voucher_redemptions(user_id, status);
CREATE INDEX IF NOT EXISTS idx_voucher_redemptions_invoice ON public.voucher_redemptions(invoice_id);

DROP TRIGGER IF EXISTS trg_vouchers_updated_at ON public.vouchers;
CREATE TRIGGER trg_vouchers_updated_at
BEFORE UPDATE ON public.vouchers
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS trg_voucher_redemptions_updated_at ON public.voucher_redemptions;
CREATE TRIGGER trg_voucher_redemptions_updated_at
BEFORE UPDATE ON public.voucher_redemptions
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.vouchers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.voucher_redemptions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS vouchers_read_authenticated ON public.vouchers;
CREATE POLICY vouchers_read_authenticated
  ON public.vouchers FOR SELECT
  TO authenticated
  USING (is_active = true OR public.is_admin());

DROP POLICY IF EXISTS vouchers_admin_write ON public.vouchers;
CREATE POLICY vouchers_admin_write
  ON public.vouchers FOR ALL
  TO authenticated
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

DROP POLICY IF EXISTS voucher_redemptions_select_self_or_admin ON public.voucher_redemptions;
CREATE POLICY voucher_redemptions_select_self_or_admin
  ON public.voucher_redemptions FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id OR public.is_admin());

DROP POLICY IF EXISTS voucher_redemptions_admin_write ON public.voucher_redemptions;
CREATE POLICY voucher_redemptions_admin_write
  ON public.voucher_redemptions FOR ALL
  TO authenticated
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

COMMENT ON TABLE public.vouchers IS 'Master coupon/voucher catalog for subscription checkout discounting.';
COMMENT ON TABLE public.voucher_redemptions IS 'Voucher reservation/application records per user and invoice.';

INSERT INTO public.vouchers (
  code,
  name,
  description,
  discount_type,
  discount_value,
  max_discount_idr,
  min_purchase_idr,
  max_redemptions,
  per_user_limit,
  is_active,
  allowed_tiers,
  metadata
) VALUES
  (
    'WELCOME10',
    'Welcome 10%',
    'Potongan 10% untuk semua paket aktif.',
    'percentage',
    10,
    50000,
    0,
    500,
    1,
    true,
    '{}'::public.membership_tier[],
    '{"seed":true,"source":"migration"}'::jsonb
  ),
  (
    'YEARLY75K',
    'Hemat Tahunan 75K',
    'Potongan Rp75.000 khusus paket tahunan.',
    'fixed_amount',
    75000,
    null,
    250000,
    300,
    1,
    true,
    '{yearly}'::public.membership_tier[],
    '{"seed":true,"source":"migration"}'::jsonb
  ),
  (
    'LIFETIME150K',
    'Lifetime Hemat 150K',
    'Potongan Rp150.000 untuk pembelian paket lifetime.',
    'fixed_amount',
    150000,
    null,
    750000,
    200,
    1,
    true,
    '{lifetime}'::public.membership_tier[],
    '{"seed":true,"source":"migration"}'::jsonb
  )
ON CONFLICT (code) DO NOTHING;
