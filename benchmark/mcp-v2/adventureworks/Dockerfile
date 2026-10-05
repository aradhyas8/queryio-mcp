# Benchmark PostgreSQL image: pinned PostgreSQL 16 plus the pinned AdventureWorks inputs,
# converted for Postgres at build time exactly as lorint/AdventureWorks-for-Postgres does.
FROM postgres:16.10-bookworm

RUN apt-get update && apt-get install -y --no-install-recommends unzip ruby && rm -rf /var/lib/apt/lists/*

RUN mkdir /data
COPY install.sql update_csvs.rb AdventureWorks-oltp-install-script.zip /data/
RUN cd /data && unzip -q AdventureWorks-oltp-install-script.zip && rm AdventureWorks-oltp-install-script.zip \
 && ruby update_csvs.rb && rm update_csvs.rb
